import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import * as lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setEnvVar } from "../../__tests__/test-utils";
import { ENV_CONSTANTS } from "../../constants";
import { getWorktreeDirLockTarget } from "../../utils/lock-path";
import { RepoOperationLock } from "../repo-operation-lock";

import type { Config } from "../../types";
import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { Mock } from "vitest";

const SHORTCUT = ENV_CONSTANTS.UNIT_TEST_SHORTCUT;

// No fs or proper-lockfile mocks here: these cases run the real lock against
// a real state directory, the way the CLI meets it on a CI container or a
// hardened host where the state directory cannot be created.
describe("RepoOperationLock against a real state directory", () => {
  const originalShortcut = process.env[SHORTCUT];
  const originalStateHome = process.env.XDG_STATE_HOME;
  let tempDir: string;
  let warn: Mock;
  let logger: Logger;
  let gitService: GitService;

  beforeEach(async () => {
    // setup.ts opts the whole worker into the no-op lock; these tests exercise the real one.
    delete process.env[SHORTCUT];
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-lock-state-"));
    warn = vi.fn();
    logger = { warn, error: vi.fn() } as unknown as Logger;
    gitService = { getBareRepoPath: () => path.join(tempDir, ".bare") } as unknown as GitService;
  });

  afterEach(async () => {
    setEnvVar(SHORTCUT, originalShortcut);
    setEnvVar("XDG_STATE_HOME", originalStateHome);
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

  it("reports lock_unavailable with the path and errno when XDG_STATE_HOME is a regular file", async () => {
    const stateFile = path.join(tempDir, "state-file");
    await fs.writeFile(stateFile, "not a directory");
    process.env.XDG_STATE_HOME = stateFile;
    const config = makeConfig();
    const target = getWorktreeDirLockTarget(config);
    expect(target.dir).toBe(path.join(stateFile, "sync-worktrees", "locks"));

    const result = await new RepoOperationLock(config, gitService, logger).acquire();

    expect(result).toEqual({
      acquired: false,
      reason: "lock_unavailable",
      path: target.dir,
      code: "ENOTDIR",
      error: expect.stringContaining("ENOTDIR"),
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain(target.dir);
    expect(message).toContain("ENOTDIR");
    expect(message).not.toMatch(/another process/i);
  });

  it("reports locked, without a warning, when another holder has the lock file", async () => {
    process.env.XDG_STATE_HOME = path.join(tempDir, "state");
    const config = makeConfig();
    const target = getWorktreeDirLockTarget(config);
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
});
