import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import * as lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setEnvVar } from "../../__tests__/test-utils";
import { ENV_CONSTANTS, PATH_CONSTANTS } from "../../constants";
import { getWorktreeDirLockTarget } from "../../utils/lock-path";
import { RepoOperationLock } from "../repo-operation-lock";

import type { Config } from "../../types";
import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { Mock } from "vitest";

const SHORTCUT = ENV_CONSTANTS.UNIT_TEST_SHORTCUT;
const LOCK_DIR = ENV_CONSTANTS.LOCK_DIR;

// No fs or proper-lockfile mocks here: these cases run the real lock against
// a real lock directory, the way the CLI meets it on a CI container or a
// hardened host where the lock directory cannot be created, and the way a
// daemon and a shell-launched run meet each other on one workstation.
describe("RepoOperationLock against a real lock directory", () => {
  const originalShortcut = process.env[SHORTCUT];
  const originalLockDir = process.env[LOCK_DIR];
  const originalStateHome = process.env.XDG_STATE_HOME;
  const originalHome = process.env.HOME;
  let tempDir: string;
  let warn: Mock;
  let logger: Logger;
  let gitService: GitService;

  beforeEach(async () => {
    // setup.ts opts the whole worker into the no-op lock; these tests exercise the real one.
    delete process.env[SHORTCUT];
    delete process.env[LOCK_DIR];
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-lock-state-")));
    warn = vi.fn();
    logger = { warn, error: vi.fn() } as unknown as Logger;
    gitService = { getBareRepoPath: () => path.join(tempDir, ".bare") } as unknown as GitService;
  });

  afterEach(async () => {
    setEnvVar(SHORTCUT, originalShortcut);
    setEnvVar(LOCK_DIR, originalLockDir);
    setEnvVar("XDG_STATE_HOME", originalStateHome);
    setEnvVar("HOME", originalHome);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeConfig(): Config {
    return {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: path.join(tempDir, "worktrees"),
      cronSchedule: "0 * * * *",
      runOnce: true,
      mode: "clone",
      branch: "main",
      __configFileDir: tempDir,
    };
  }

  it("reports lock_unavailable with the path and errno when SYNC_WORKTREES_LOCK_DIR is a regular file", async () => {
    const lockDirFile = path.join(tempDir, "lock-dir-file");
    await fs.writeFile(lockDirFile, "not a directory");
    process.env[LOCK_DIR] = lockDirFile;
    const config = makeConfig();
    const target = getWorktreeDirLockTarget(config);
    expect(target.dir).toBe(lockDirFile);

    const result = await new RepoOperationLock(config, gitService, logger).acquire();

    expect(result).toEqual({
      acquired: false,
      reason: "lock_unavailable",
      path: target.dir,
      code: "EEXIST",
      error: expect.stringContaining("EEXIST"),
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain(target.dir);
    expect(message).toContain("EEXIST");
    expect(message).not.toMatch(/another process/i);
  });

  it("reports locked, without a warning, when another holder has the lock file", async () => {
    const config = makeConfig();
    const target = getWorktreeDirLockTarget(config);
    expect(target.dir).toBe(path.join(tempDir, PATH_CONSTANTS.LOCK_DIR_NAME));
    const lockTarget = path.join(target.dir, target.file);
    await fs.mkdir(target.dir, { recursive: true });
    await fs.writeFile(lockTarget, "");
    // Same options the lock uses, so both sides contend for the same lockfile.
    const releaseHolder = await lockfile.lock(lockTarget, { realpath: false, stale: 60_000 });

    try {
      const result = await new RepoOperationLock(config, gitService, logger).acquire();
      expect(result).toEqual({ acquired: false, reason: "locked" });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await releaseHolder();
    }

    // Once the holder lets go, the same lock is taken normally.
    const retry = await new RepoOperationLock(config, gitService, logger).acquire();
    expect(retry.acquired).toBe(true);
    if (retry.acquired) await retry.release();
    expect(warn).not.toHaveBeenCalled();
  });

  it("makes a run with XDG_STATE_HOME and HOME set contend with a holder that had neither (#T47)", async () => {
    // Holder: a systemd/cron-started daemon with a minimal environment.
    delete process.env.XDG_STATE_HOME;
    const config = makeConfig();
    const holder = await new RepoOperationLock(config, gitService, logger).acquire();
    expect(holder.acquired).toBe(true);
    if (!holder.acquired) throw new Error("expected the holder to acquire the lock");

    try {
      // Contender: a --runOnce from an interactive shell whose dotfiles export
      // XDG_STATE_HOME, under a different HOME (`sudo` without -E).
      process.env.XDG_STATE_HOME = path.join(tempDir, "x");
      process.env.HOME = path.join(tempDir, "other-home");
      const contender = await new RepoOperationLock(makeConfig(), gitService, logger).acquire();

      expect(contender).toEqual({ acquired: false, reason: "locked" });
      expect(warn).not.toHaveBeenCalled();
      // Nothing was created under the contender's would-be state or home dirs.
      await expect(fs.access(path.join(tempDir, "x"))).rejects.toThrow();
      await expect(fs.access(path.join(tempDir, "other-home"))).rejects.toThrow();
    } finally {
      await holder.release();
    }

    // With the holder gone the shell-launched run takes the very same lock.
    const retry = await new RepoOperationLock(makeConfig(), gitService, logger).acquire();
    expect(retry.acquired).toBe(true);
    if (retry.acquired) await retry.release();
    expect(warn).not.toHaveBeenCalled();
  });
});
