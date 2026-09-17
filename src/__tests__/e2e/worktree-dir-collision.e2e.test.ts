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

// Two entries pointing at one worktreeDir used to load fine. At runtime each
// repo's sync found the other's checkouts unregistered in its own bare repo
// and moved them to trash before creating its own, and the run still reported
// every repo as synced with exit code 0. The config must be rejected before
// any git command runs, naming both entries and the shared path.
describe("CLI rejects a config whose entries share a worktreeDir", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  let tempDir: string;
  let remote: string;
  let sharedWorktreeDir: string;
  let bareRepoDirA: string;
  let bareRepoDirB: string;
  let configPath: string;

  async function writeConfig(worktreeDirA: string, worktreeDirB: string): Promise<void> {
    await fs.writeFile(
      configPath,
      `export default {
  repositories: [
    {
      name: "app-a",
      repoUrl: "file://${remote}",
      worktreeDir: "${worktreeDirA}",
      bareRepoDir: "${bareRepoDirA}",
    },
    {
      name: "app-b",
      repoUrl: "file://${remote}",
      worktreeDir: "${worktreeDirB}",
      bareRepoDir: "${bareRepoDirB}",
    }
  ]
};
`,
    );
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-shared-worktree-dir-"));
    remote = path.join(tempDir, "remote", "app.git");
    sharedWorktreeDir = path.join(tempDir, "worktrees");
    bareRepoDirA = path.join(tempDir, ".bare", "app-a");
    bareRepoDirB = path.join(tempDir, ".bare", "app-b");
    configPath = path.join(tempDir, "sync-worktrees.config.js");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

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
    await initGit.addRemote("origin", remote);
    await initGit.push("origin", "main");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await fs.rm(initDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function runCli(args: string[]): CliRun {
    const result = spawnSync(process.execPath, [binPath, ...args], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  async function exists(p: string): Promise<boolean> {
    return fs.access(p).then(
      () => true,
      () => false,
    );
  }

  it("fails --runOnce and list before any git command, then syncs once each entry has its own worktreeDir", async () => {
    await writeConfig(sharedWorktreeDir, sharedWorktreeDir);

    const run = runCli(["--config", configPath, "--runOnce"]);
    const runOutput = run.stdout + run.stderr;
    expect(run.status, runOutput).toBe(1);
    expect(run.stderr).toContain("Error loading config file");
    expect(run.stderr).toContain("'app-a' and 'app-b'");
    expect(run.stderr).toContain(`same worktreeDir '${sharedWorktreeDir}'`);
    // No repository was initialized or synced: nothing was cloned and no
    // worktree directory was created.
    expect(runOutput).not.toContain("Syncing 2 repositories");
    expect(runOutput).not.toContain("Repository: app-a");
    expect(runOutput).not.toContain("synced");
    expect(await exists(sharedWorktreeDir)).toBe(false);
    expect(await exists(bareRepoDirA)).toBe(false);
    expect(await exists(bareRepoDirB)).toBe(false);

    const list = runCli(["list", "--config", configPath]);
    expect(list.status, list.stdout + list.stderr).toBe(1);
    expect(list.stderr).toContain("'app-a' and 'app-b'");
    expect(list.stderr).toContain("same worktreeDir");
    expect(list.stdout).not.toContain("Configured repositories");

    // Giving each entry its own worktreeDir is enough: both sync.
    const worktreeDirA = path.join(tempDir, "worktrees-a");
    const worktreeDirB = path.join(tempDir, "worktrees-b");
    await writeConfig(worktreeDirA, worktreeDirB);
    const fixed = runCli(["--config", configPath, "--runOnce"]);
    expect(fixed.status, fixed.stdout + fixed.stderr).toBe(0);
    expect(fixed.stdout).toContain("2 synced");
    await expect(fs.access(path.join(worktreeDirA, "main"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(worktreeDirB, "main"))).resolves.toBeUndefined();
  }, 120_000);
});
