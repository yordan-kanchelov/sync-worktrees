import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import * as lockfile from "proper-lockfile";
import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ENV_CONSTANTS } from "../../constants";
import { getWorktreeDirLockTarget } from "../../utils/lock-path";
import { setEnvVar } from "../test-utils";

const LOCK_DIR = ENV_CONSTANTS.LOCK_DIR;

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

// A CI container or hardened host where the lock directory cannot be created
// (SYNC_WORKTREES_LOCK_DIR pointing at a file, a read-only volume) must fail
// the run loudly: nothing was cloned, fetched or checked out, so a green exit
// that blames "another process" for holding the lock would let the pipeline
// pass having synced nothing. Real contention stays a skip with exit code 0 —
// and it must be real contention no matter how the two processes' HOME and
// XDG_STATE_HOME differ, since a daemon and a shell-launched run rarely agree
// on either.
describe("CLI reports an unavailable repo lock as a failure", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  const originalLockDir = process.env[LOCK_DIR];
  let tempDir: string;
  let bareRepo: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let configPath: string;

  beforeEach(async () => {
    delete process.env[LOCK_DIR];
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
    setEnvVar(LOCK_DIR, originalLockDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function runCli(envOverrides: NodeJS.ProcessEnv): CliRun {
    const result = spawnSync(process.execPath, [binPath, "--config", configPath, "--runOnce"], {
      encoding: "utf8",
      env: { ...process.env, ...envOverrides },
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  // The lock lives next to the canonical worktreeDir whatever the child's
  // environment says, so the path the child uses can be derived right here.
  function defaultLockTarget(): { dir: string; file: string } {
    return getWorktreeDirLockTarget({
      repoUrl: `file://${bareRepo}`,
      worktreeDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
    });
  }

  it("exits 1 and counts the repo as failed when the lock directory is a regular file", async () => {
    const lockDirFile = path.join(tempDir, "lock-dir-file");
    await fs.writeFile(lockDirFile, "not a directory");

    const run = runCli({ [LOCK_DIR]: lockDirFile });
    const output = run.stdout + run.stderr;

    expect(run.status, output).toBe(1);
    expect(run.stdout).toContain("0 synced");
    expect(run.stdout).toContain("1 failed (1 lock unavailable)");
    expect(run.stderr).toContain("repository lock unavailable");
    expect(run.stderr).toContain(lockDirFile);
    expect(run.stderr).toContain("EEXIST");
    expect(output).not.toMatch(/another process holds/i);
    expect(output).not.toContain("Synchronization finished");

    // Nothing ran: no clone, no worktrees.
    await expect(fs.access(worktreeDir)).rejects.toThrow();
  }, 60_000);

  it("still exits 0 and reports a skip when another process really holds the lock", async () => {
    const target = defaultLockTarget();
    expect(target.dir).toBe(path.join(await fs.realpath(tempDir), ".sync-worktrees-locks"));
    const lockTarget = path.join(target.dir, target.file);
    await fs.mkdir(target.dir, { recursive: true });
    await fs.writeFile(lockTarget, "");
    // Hold the worktreeDir lock from this process with the same lockfile
    // options the CLI uses, so the child contends for the same lockfile.
    const releaseHolder = await lockfile.lock(lockTarget, { realpath: false, stale: 120_000 });

    // The child runs as a shell-launched process would: XDG_STATE_HOME and
    // HOME both differ from this (holder) process, and neither may move it
    // onto a different lock file.
    let run: CliRun;
    try {
      run = runCli({ XDG_STATE_HOME: path.join(tempDir, "shell-state"), HOME: path.join(tempDir, "shell-home") });
    } finally {
      await releaseHolder();
    }
    const output = run.stdout + run.stderr;

    expect(run.status, output).toBe(0);
    expect(run.stdout).toContain("0 synced, 1 skipped, 0 failed");
    expect(run.stderr).toContain("Another process holds the sync lock");
    expect(output).not.toContain("lock unavailable");
    // Nothing ran under the child's would-be state dir, and no second lock appeared.
    await expect(fs.access(path.join(tempDir, "shell-state"))).rejects.toThrow();
    await expect(fs.access(path.join(tempDir, "shell-home"))).rejects.toThrow();
    await expect(fs.access(worktreeDir)).rejects.toThrow();
  }, 60_000);
});
