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

// The bare repo is found by bareRepoDir alone, so after a repoUrl change — an
// org migration, a fork swapped for upstream — an existing bare repo would
// keep fetching the remote it was cloned from: branches that only exist on
// the new remote never appear and nothing in the log says why. The run must
// fail naming both remotes, and the suggested `remote set-url` must be
// enough to converge.
describe("CLI refuses an existing bare repo whose origin is not the configured repoUrl", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  let tempDir: string;
  let remoteA: string;
  let remoteB: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let stateHome: string;
  let configPath: string;

  async function writeConfig(repoUrl: string): Promise<void> {
    await fs.writeFile(
      configPath,
      `export default {
  repositories: [
    {
      name: "app",
      repoUrl: "${repoUrl}",
      worktreeDir: "${worktreeDir}",
      bareRepoDir: "${bareRepoDir}",
    }
  ]
};
`,
    );
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-origin-mismatch-"));
    remoteA = path.join(tempDir, "old-org", "app.git");
    remoteB = path.join(tempDir, "new-org", "app.git");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    stateHome = path.join(tempDir, "state");
    configPath = path.join(tempDir, "sync-worktrees.config.js");

    await fs.mkdir(path.dirname(remoteA), { recursive: true });
    await fs.mkdir(path.dirname(remoteB), { recursive: true });
    await simpleGit().init(["--bare", remoteA]);
    await simpleGit().init(["--bare", remoteB]);

    // One history pushed to both remotes; `only-on-b` exists on remote B alone.
    const initDir = path.join(tempDir, "init");
    await fs.mkdir(initDir);
    const initGit = simpleGit(initDir);
    await initGit.init();
    await initGit.addConfig("user.name", "Test User");
    await initGit.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(initDir, "README.md"), "# app");
    await initGit.add(".");
    await initGit.commit("Initial commit");
    await initGit.branch(["-M", "main"]);
    await initGit.addRemote("a", remoteA);
    await initGit.addRemote("b", remoteB);
    await initGit.push("a", "main");
    await initGit.push("b", "main");
    await initGit.checkoutLocalBranch("only-on-b");
    await fs.writeFile(path.join(initDir, "b.txt"), "only on remote B");
    await initGit.add(".");
    await initGit.commit("Add b.txt");
    await initGit.push("b", "only-on-b");
    for (const remote of [remoteA, remoteB]) {
      await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
    }
    await fs.rm(initDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function runCli(): CliRun {
    const result = spawnSync(process.execPath, [binPath, "--config", configPath, "--runOnce"], {
      encoding: "utf8",
      env: { ...process.env, XDG_STATE_HOME: stateHome },
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("fails naming both remotes after repoUrl changes, then syncs once the remote is updated", async () => {
    const urlA = `file://${remoteA}`;
    const urlB = `file://${remoteB}`;

    await writeConfig(urlA);
    const first = runCli();
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain("Synchronization finished");
    await expect(fs.access(path.join(worktreeDir, "main"))).resolves.toBeUndefined();

    // Same bareRepoDir, new remote: the bare repo still points at A.
    await writeConfig(urlB);
    const second = runCli();
    const secondOutput = second.stdout + second.stderr;
    expect(second.status, secondOutput).toBe(1);
    expect(second.stderr).toContain("Failed to initialize repository");
    expect(second.stderr).toContain(`has origin '${urlA}', expected '${urlB}'`);
    expect(second.stderr).toContain(`git -C "${bareRepoDir}" remote set-url origin "${urlB}"`);
    expect(second.stdout).toContain("0 synced");
    expect(second.stdout).toContain("1 failed");
    // Nothing was fetched from either remote and the bare repo was left as it was.
    expect(secondOutput).not.toContain("Fetching remote branches");
    expect(secondOutput).not.toContain("Synchronization finished");
    expect((await simpleGit(bareRepoDir).raw(["remote", "get-url", "origin"])).trim()).toBe(urlA);
    expect((await fs.readdir(worktreeDir)).find((d) => d.startsWith("only-on-b"))).toBeUndefined();

    // The suggested remedy converges: the next run picks up the branch that exists only on B.
    await simpleGit(bareRepoDir).raw(["remote", "set-url", "origin", urlB]);
    const third = runCli();
    expect(third.status, third.stdout + third.stderr).toBe(0);
    expect(third.stdout).toContain("Synchronization finished");
    // Worktree directories carry a suffix, so locate the branch by prefix.
    const onlyOnBDir = (await fs.readdir(worktreeDir)).find((d) => d.startsWith("only-on-b"));
    expect(onlyOnBDir).toBeDefined();
    await expect(fs.readFile(path.join(worktreeDir, onlyOnBDir ?? "", "b.txt"), "utf8")).resolves.toBe(
      "only on remote B",
    );
  }, 120_000);
});
