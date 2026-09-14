import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Real git, real clone-mode checkout. Two promises the clone-mode sparse
// re-apply did not keep (#T68):
//
//   - README's narrowing-safety paragraph says a sparse update that drops a
//     path out of the cone first checks the worktree is clean. Worktree mode
//     always did; clone mode narrowed regardless and left git to print its own
//     "were left despite sparse patterns" warning.
//   - A sparse config git rejects warned once per tick and exited 0, so the
//     outcome held no failure and nothing watching the run ever learned.
describe("Clone-mode sparse-checkout re-apply", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");

  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-clone-sparse-")));
    remote = path.join(tempDir, "remote", "app.git");
    worktreeDir = path.join(tempDir, "checkout");
    configPath = path.join(tempDir, "sync-worktrees.config.js");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

    const seedDir = path.join(tempDir, "seed");
    await fs.mkdir(seedDir);
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.mkdir(path.join(seedDir, "pkg"));
    await fs.writeFile(path.join(seedDir, "pkg", "a.txt"), "a\n");
    await fs.mkdir(path.join(seedDir, "other"));
    await fs.writeFile(path.join(seedDir, "other", "b.txt"), "b\n");
    await fs.writeFile(path.join(seedDir, "root.txt"), "root\n");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await fs.rm(seedDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(include: string[]): Promise<void> {
    await fs.writeFile(
      configPath,
      `export default {
  repositories: [
    {
      name: "app",
      repoUrl: ${JSON.stringify(`file://${remote}`)},
      worktreeDir: ${JSON.stringify(worktreeDir)},
      mode: "clone",
      branch: "main",
      retry: { maxAttempts: 1, initialDelayMs: 0 },
      sparseCheckout: { include: ${JSON.stringify(include)} },
    }
  ]
};
`,
    );
  }

  function runCli(): CliRun {
    const result = spawnSync(process.execPath, [binPath, "--config", configPath, "--runOnce"], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  async function sparsePatterns(): Promise<string[]> {
    const out = await simpleGit(worktreeDir).raw(["sparse-checkout", "list"]);
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  // A commit the clone can only reach by fast-forwarding, used to show the
  // sparse step never blocks the merge the sync exists for.
  async function pushCommit(): Promise<string> {
    const pushDir = path.join(tempDir, "push");
    await fs.rm(pushDir, { recursive: true, force: true });
    await simpleGit().clone(remote, pushDir);
    const push = simpleGit(pushDir);
    await push.addConfig("user.name", "Test User");
    await push.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(pushDir, "pkg", "a.txt"), "a2\n");
    await push.add(".");
    await push.commit("Second commit");
    await push.push("origin", "main");
    return (await push.revparse(["HEAD"])).trim();
  }

  it("defers a narrowing sparse update while the tree is dirty, then applies it when clean", async () => {
    await writeConfig(["other", "pkg"]);
    const first = runCli();
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(await sparsePatterns()).toEqual(["other", "pkg"]);

    // A local edit inside the directory the next config drops out of the cone.
    const edited = path.join(worktreeDir, "other", "b.txt");
    await fs.writeFile(edited, "local edit\n");
    await writeConfig(["pkg"]);

    const second = runCli();
    const secondOutput = second.stdout + second.stderr;
    expect(second.status, secondOutput).toBe(0);
    expect(secondOutput).toContain("Skipping sparse-checkout narrowing for 'app'");
    // The bug: 'other' used to be gone from the pattern list after this run.
    expect(await sparsePatterns()).toEqual(["other", "pkg"]);
    await expect(fs.readFile(edited, "utf8")).resolves.toBe("local edit\n");

    // Only deferred: the same narrowing lands on the first clean tick.
    await simpleGit(worktreeDir).raw(["checkout", "--", "other/b.txt"]);
    const third = runCli();
    const thirdOutput = third.stdout + third.stderr;
    expect(third.status, thirdOutput).toBe(0);
    expect(thirdOutput).not.toContain("Skipping sparse-checkout narrowing");
    expect(await sparsePatterns()).toEqual(["pkg"]);
    await expect(fs.access(path.join(worktreeDir, "other"))).rejects.toThrow();
  }, 60_000);

  it("fails the run when git rejects the sparse config, without blocking the merge", async () => {
    await writeConfig(["pkg"]);
    const first = runCli();
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(await sparsePatterns()).toEqual(["pkg"]);

    // A cone pattern git refuses: "specify directories rather than patterns
    // (no leading slash)". `sparse-checkout set` fails and the pattern list on
    // disk is left exactly as it was.
    const tip = await pushCommit();
    await writeConfig(["/pkg"]);

    const second = runCli();
    const secondOutput = second.stdout + second.stderr;
    // The bug: this used to be a lone warning, 1 synced, 0 failed, exit 0.
    expect(second.status, secondOutput).toBe(1);
    expect(secondOutput).toContain("Failed to reapply sparse-checkout for 'app'");
    expect(second.stdout).toContain("1 failed");
    expect(await sparsePatterns()).toEqual(["pkg"]);

    // Not fatal: the fast-forward still happened.
    expect((await simpleGit(worktreeDir).revparse(["HEAD"])).trim()).toBe(tip);
  }, 60_000);
});
