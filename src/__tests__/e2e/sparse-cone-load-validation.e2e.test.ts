import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface CliRun {
  status: number | null;
  output: string;
  trace: string;
}

// Real git, real worktree mode. A cone-mode `include` git refuses used to load
// fine and then cost a `worktree add` plus a rollback per branch, every tick,
// forever (#T80). GIT_TRACE is written to a file rather than read off stderr so
// the assertion is about the git processes the run actually started, not about
// what the logger chose to print.
describe("Sparse-checkout cone rules at config load", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");

  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let configPath: string;
  let tracePath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-cone-load-")));
    remote = path.join(tempDir, "remote", "app.git");
    worktreeDir = path.join(tempDir, "worktrees");
    configPath = path.join(tempDir, "sync-worktrees.config.js");
    tracePath = path.join(tempDir, "git-trace.log");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

    const seedDir = path.join(tempDir, "seed");
    await fs.mkdir(seedDir);
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.mkdir(path.join(seedDir, "apps", "web"), { recursive: true });
    await fs.writeFile(path.join(seedDir, "apps", "web", "a.txt"), "a\n");
    await fs.mkdir(path.join(seedDir, "docs"));
    await fs.writeFile(path.join(seedDir, "docs", "d.txt"), "d\n");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");
    await seed.checkoutLocalBranch("feature");
    await fs.writeFile(path.join(seedDir, "apps", "web", "b.txt"), "b\n");
    await seed.add(".");
    await seed.commit("Feature commit");
    await seed.push("origin", "feature");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await fs.rm(seedDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function runCli(include: string[]): Promise<CliRun> {
    await fs.writeFile(
      configPath,
      `export default {
  repositories: [
    {
      name: "monorepo",
      repoUrl: ${JSON.stringify(`file://${remote}`)},
      worktreeDir: ${JSON.stringify(worktreeDir)},
      bareRepoDir: ${JSON.stringify(path.join(tempDir, ".bare"))},
      retry: { maxAttempts: 1, initialDelayMs: 0 },
      sparseCheckout: { include: ${JSON.stringify(include)} },
    }
  ]
};
`,
    );
    const result = spawnSync(process.execPath, [binPath, "--config", configPath, "--runOnce"], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TRACE: tracePath },
    });
    const trace = await fs.readFile(tracePath, "utf8").catch(() => "");
    return { status: result.status, output: result.stdout + result.stderr, trace };
  }

  // The control half. Without it a "no worktree add" assertion would pass on a
  // run that never traced anything at all.
  it("adds worktrees for a cone include git accepts", async () => {
    const run = await runCli(["apps/web"]);

    expect(run.status, run.output).toBe(0);
    expect(run.trace).toContain("worktree add");
    expect(await fs.readdir(worktreeDir)).toHaveLength(2);
    await expect(fs.access(path.join(worktreeDir, "main", "apps", "web", "a.txt"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(worktreeDir, "main", "docs"))).rejects.toThrow();
  }, 60_000);

  it("refuses a leading-slash cone include before any worktree is added", async () => {
    const run = await runCli(["/apps/web"]);

    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain("'/apps/web'");
    expect(run.output).toContain("monorepo");
    expect(run.output).toContain("Drop the leading slash");
    // The point of the fix: not one `worktree add`, and nothing to roll back.
    expect(run.trace).not.toContain("worktree add");
    await expect(fs.access(worktreeDir)).rejects.toThrow();
  }, 60_000);
});
