import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import * as lockfile from "proper-lockfile";
import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getWorktreeDirLockTarget } from "../../utils/lock-path";
import { setEnvVar } from "../test-utils";

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

// A CI container or hardened host where the state directory cannot be
// created (XDG_STATE_HOME pointing at a file, a read-only volume) must fail
// the run loudly: nothing was cloned, fetched or checked out, so a green exit
// that blames "another process" for holding the lock would let the pipeline
// pass having synced nothing. Real contention stays a skip with exit code 0.
describe("CLI reports an unavailable repo lock as a failure", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  let tempDir: string;
  let bareRepo: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-lock-unavailable-"));
    bareRepo = path.join(tempDir, "test-repo.git");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare");

    await simpleGit().init(["--bare", bareRepo]);
    const initDir = path.join(tempDir, "init");
    await fs.mkdir(initDir);
    const initGit = simpleGit(initDir);
    await initGit.init();
    await initGit.addConfig("user.name", "Test User");
    await initGit.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(initDir, "README.md"), "# Test Repository");
    await initGit.add(".");
    await initGit.commit("Initial commit");
    await initGit.branch(["-M", "main"]);
    await initGit.addRemote("origin", bareRepo);
    await initGit.push("origin", "main");
    await simpleGit(bareRepo).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await fs.rm(initDir, { recursive: true });

    configPath = path.join(tempDir, "sync-worktrees.config.js");
    await fs.writeFile(
      configPath,
      `export default {
  repositories: [
    {
      name: "test-repo",
      repoUrl: "file://${bareRepo}",
      worktreeDir: "${worktreeDir}",
      bareRepoDir: "${bareRepoDir}",
    }
  ]
};
`,
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function runCli(stateHome: string): CliRun {
    const result = spawnSync(process.execPath, [binPath, "--config", configPath, "--runOnce"], {
      encoding: "utf8",
      env: { ...process.env, XDG_STATE_HOME: stateHome },
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  // getWorktreeDirLockTarget reads XDG_STATE_HOME from this process; point it at
  // the child's state dir just long enough to derive the path the child uses.
  function lockDirFor(stateHome: string): { dir: string; file: string } {
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateHome;
    try {
      return getWorktreeDirLockTarget({
        repoUrl: `file://${bareRepo}`,
        worktreeDir,
        cronSchedule: "0 * * * *",
        runOnce: true,
      });
    } finally {
      setEnvVar("XDG_STATE_HOME", previous);
    }
  }

  it("exits 1 and counts the repo as failed when the state directory is a regular file", async () => {
    const stateFile = path.join(tempDir, "state-file");
    await fs.writeFile(stateFile, "not a directory");
    const lockDir = lockDirFor(stateFile).dir;
    expect(lockDir).toBe(path.join(stateFile, "sync-worktrees", "locks"));

    const run = runCli(stateFile);
    const output = run.stdout + run.stderr;

    expect(run.status, output).toBe(1);
    expect(run.stdout).toContain("0 synced");
    expect(run.stdout).toContain("1 failed (1 lock unavailable)");
    expect(run.stderr).toContain("repository lock unavailable");
    expect(run.stderr).toContain(lockDir);
    expect(run.stderr).toContain("ENOTDIR");
    expect(output).not.toMatch(/another process holds/i);
    expect(output).not.toContain("Synchronization finished");

    // Nothing ran: no clone, no worktrees.
    await expect(fs.access(worktreeDir)).rejects.toThrow();
  }, 60_000);

  it("still exits 0 and reports a skip when another process really holds the lock", async () => {
    const stateHome = path.join(tempDir, "state");
    const target = lockDirFor(stateHome);
    const lockTarget = path.join(target.dir, target.file);
    await fs.mkdir(target.dir, { recursive: true });
    await fs.writeFile(lockTarget, "");
    // Hold the worktreeDir lock from this process with the same lockfile
    // options the CLI uses, so the child contends for the same lockfile.
    const releaseHolder = await lockfile.lock(lockTarget, { realpath: false, stale: 120_000 });

    let run: CliRun;
    try {
      run = runCli(stateHome);
    } finally {
      await releaseHolder();
    }
    const output = run.stdout + run.stderr;

    expect(run.status, output).toBe(0);
    expect(run.stdout).toContain("0 synced, 1 skipped, 0 failed");
    expect(run.stderr).toContain("Another process holds the sync lock");
    expect(output).not.toContain("lock unavailable");
  }, 60_000);
});
