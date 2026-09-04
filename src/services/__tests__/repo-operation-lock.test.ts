import * as fs from "fs/promises";
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
import type { RepoLockAcquireResult, RepoLockRelease } from "../repo-operation-lock";
import type { Mock } from "vitest";

vi.mock("fs/promises");
vi.mock("proper-lockfile");

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    repoUrl: "https://github.com/test/repo.git",
    worktreeDir: "/tmp/worktrees",
    cronSchedule: "0 * * * *",
    runOnce: false,
    ...overrides,
  };
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function expectAcquired(result: RepoLockAcquireResult): RepoLockRelease {
  expect(result.acquired).toBe(true);
  if (!result.acquired) throw new Error("expected the lock to be acquired");
  return result.release;
}

const SHORTCUT = ENV_CONSTANTS.UNIT_TEST_SHORTCUT;

describe("RepoOperationLock", () => {
  const originalShortcut = process.env[SHORTCUT];
  const originalNodeEnv = process.env.NODE_ENV;
  const release = vi.fn(async () => {});
  let gitService: Pick<GitService, "getBareRepoPath">;
  let warn: Mock;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    // setup.ts opts the whole worker into the no-op lock; these tests exercise the real one.
    delete process.env[SHORTCUT];
    gitService = {
      getBareRepoPath: vi.fn(() => "/tmp/bare.git"),
    };
    warn = vi.fn();
    logger = { warn } as unknown as Logger;
    (fs.mkdir as Mock).mockResolvedValue(undefined);
    (fs.writeFile as Mock).mockResolvedValue(undefined);
    (lockfile.lock as Mock).mockResolvedValue(release);
  });

  afterEach(() => {
    setEnvVar(SHORTCUT, originalShortcut);
    setEnvVar("NODE_ENV", originalNodeEnv);
  });

  it("returns a no-op release while the unit-test shortcut is active for this process", async () => {
    process.env[SHORTCUT] = String(process.pid);
    const lock = new RepoOperationLock(makeConfig(), gitService as GitService);

    const releaseLock = expectAcquired(await lock.acquire());
    await releaseLock();

    expect(lockfile.lock).not.toHaveBeenCalled();
  });

  it("takes the real locks when NODE_ENV=test but the unit-test shortcut is unset", async () => {
    // A shell, CI job or .env exporting NODE_ENV=test must not switch off
    // cross-process locking: only the tool-owned shortcut may.
    process.env.NODE_ENV = "test";
    expect(process.env[SHORTCUT]).toBeUndefined();
    const config = makeConfig();
    const worktreeTarget = getWorktreeDirLockTarget(config);
    const lock = new RepoOperationLock(config, gitService as GitService);

    expectAcquired(await lock.acquire());

    expect(lockfile.lock).toHaveBeenCalledTimes(2);
    expect(lockfile.lock).toHaveBeenCalledWith("/tmp/bare.git", expect.objectContaining({ retries: 0 }));
    expect(lockfile.lock).toHaveBeenCalledWith(
      path.join(worktreeTarget.dir, worktreeTarget.file),
      expect.objectContaining({ retries: 0 }),
    );
  });

  it("ignores a shortcut value inherited from another process", async () => {
    // The vitest worker exports its own pid; a child process (the built CLI
    // under the e2e suites, a hook command) inherits that value and must lock.
    process.env[SHORTCUT] = String(process.pid + 1);
    const lock = new RepoOperationLock(makeConfig(), gitService as GitService);

    expectAcquired(await lock.acquire());
    expect(lockfile.lock).toHaveBeenCalledTimes(2);
  });

  it("locks both the bare repository path and the worktreeDir lock file in worktree mode", async () => {
    const config = makeConfig();
    const worktreeTarget = getWorktreeDirLockTarget(config);
    const lock = new RepoOperationLock(config, gitService as GitService);

    const releaseLock = expectAcquired(await lock.acquire());

    expect(fs.mkdir).toHaveBeenCalledWith("/tmp/bare.git", { recursive: true });
    expect(lockfile.lock).toHaveBeenCalledWith(
      "/tmp/bare.git",
      expect.objectContaining({ retries: 0, realpath: false, onCompromised: expect.any(Function) }),
    );
    expect(lockfile.lock).toHaveBeenCalledWith(
      path.join(worktreeTarget.dir, worktreeTarget.file),
      expect.objectContaining({ retries: 0, realpath: false }),
    );

    await releaseLock();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("releases the bare-repo lock and reports locked when the worktreeDir lock is contended in worktree mode", async () => {
    (lockfile.lock as Mock).mockResolvedValueOnce(release).mockRejectedValueOnce(errno("ELOCKED", "locked"));
    const lock = new RepoOperationLock(makeConfig(), gitService as GitService, logger);

    await expect(lock.acquire()).resolves.toEqual({ acquired: false, reason: "locked" });
    expect(release).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("locks a stable clone-mode lock file", async () => {
    const config = makeConfig({
      mode: "clone",
      branch: "main",
      __configFileDir: "/tmp/config",
    });
    const target = getWorktreeDirLockTarget(config);
    const lock = new RepoOperationLock(config, gitService as GitService);

    await expect(lock.acquire()).resolves.toEqual({ acquired: true, release });

    expect(fs.mkdir).toHaveBeenCalledWith(target.dir, { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledWith(path.join(target.dir, target.file), "", { flag: "a" });
    expect(lockfile.lock).toHaveBeenCalledWith(
      path.join(target.dir, target.file),
      expect.objectContaining({ retries: 0, realpath: false }),
    );
  });

  it("reports locked, without a warning, when another process holds the lock", async () => {
    (lockfile.lock as Mock).mockRejectedValue(errno("ELOCKED", "locked"));
    const lock = new RepoOperationLock(makeConfig(), gitService as GitService, logger);

    await expect(lock.acquire()).resolves.toEqual({ acquired: false, reason: "locked" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports lock_unavailable with path and errno when lock acquisition fails for a non-ELOCKED reason in worktree mode (#5)", async () => {
    (lockfile.lock as Mock).mockRejectedValue(errno("EACCES", "permission denied"));
    const lock = new RepoOperationLock(makeConfig(), gitService as GitService, logger);

    await expect(lock.acquire()).resolves.toEqual({
      acquired: false,
      reason: "lock_unavailable",
      path: "/tmp/bare.git",
      code: "EACCES",
      error: "permission denied",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("/tmp/bare.git"));
  });

  it("reports lock_unavailable with path and errno when lock acquisition fails for a non-ELOCKED reason in clone mode (#5)", async () => {
    (lockfile.lock as Mock).mockRejectedValue(errno("EROFS", "read-only file system"));
    const config = makeConfig({ mode: "clone", branch: "main", __configFileDir: "/tmp/config" });
    const target = getWorktreeDirLockTarget(config);
    const lock = new RepoOperationLock(config, gitService as GitService, logger);

    await expect(lock.acquire()).resolves.toEqual({
      acquired: false,
      reason: "lock_unavailable",
      path: path.join(target.dir, target.file),
      code: "EROFS",
      error: "read-only file system",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EROFS"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(path.join(target.dir, target.file)));
  });

  it("reports lock_unavailable, not locked, when the lock directory cannot be prepared", async () => {
    // XDG_STATE_HOME pointing at a file, an unwritable ~/.cache: mkdir fails
    // before any lock is attempted. Nothing holds the lock — say so.
    const config = makeConfig({ mode: "clone", branch: "main", __configFileDir: "/tmp/config" });
    const target = getWorktreeDirLockTarget(config);
    (fs.mkdir as Mock).mockRejectedValue(errno("ENOTDIR", `ENOTDIR: not a directory, mkdir '${target.dir}'`));
    const lock = new RepoOperationLock(config, gitService as GitService, logger);

    await expect(lock.acquire()).resolves.toEqual({
      acquired: false,
      reason: "lock_unavailable",
      path: target.dir,
      code: "ENOTDIR",
      error: `ENOTDIR: not a directory, mkdir '${target.dir}'`,
    });
    expect(lockfile.lock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(target.dir));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ENOTDIR"));
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/another process/i));
  });

  it("reports lock_unavailable when the lock file itself cannot be created", async () => {
    const config = makeConfig({ mode: "clone", branch: "main", __configFileDir: "/tmp/config" });
    const target = getWorktreeDirLockTarget(config);
    const lockTarget = path.join(target.dir, target.file);
    (fs.writeFile as Mock).mockRejectedValue(errno("EACCES", `EACCES: permission denied, open '${lockTarget}'`));
    const lock = new RepoOperationLock(config, gitService as GitService, logger);

    await expect(lock.acquire()).resolves.toEqual({
      acquired: false,
      reason: "lock_unavailable",
      path: lockTarget,
      code: "EACCES",
      error: `EACCES: permission denied, open '${lockTarget}'`,
    });
    expect(lockfile.lock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(lockTarget));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
  });

  it("reports lock_unavailable when the bare repository directory cannot be prepared in worktree mode", async () => {
    (fs.mkdir as Mock).mockRejectedValue(errno("EROFS", "EROFS: read-only file system, mkdir '/tmp/bare.git'"));
    const lock = new RepoOperationLock(makeConfig(), gitService as GitService, logger);

    await expect(lock.acquire()).resolves.toEqual({
      acquired: false,
      reason: "lock_unavailable",
      path: "/tmp/bare.git",
      code: "EROFS",
      error: "EROFS: read-only file system, mkdir '/tmp/bare.git'",
    });
    expect(lockfile.lock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("/tmp/bare.git"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EROFS"));
  });

  it("releases the bare-repo lock and reports lock_unavailable when the worktreeDir lock cannot be prepared", async () => {
    const config = makeConfig();
    const target = getWorktreeDirLockTarget(config);
    // First mkdir is the bare path (succeeds), second is the lock directory.
    (fs.mkdir as Mock)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(errno("ENOSPC", `ENOSPC: no space left on device, mkdir '${target.dir}'`));
    const lock = new RepoOperationLock(config, gitService as GitService, logger);

    await expect(lock.acquire()).resolves.toEqual({
      acquired: false,
      reason: "lock_unavailable",
      path: target.dir,
      code: "ENOSPC",
      error: `ENOSPC: no space left on device, mkdir '${target.dir}'`,
    });
    expect(lockfile.lock).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
