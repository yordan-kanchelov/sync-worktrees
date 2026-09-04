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

const SHORTCUT = ENV_CONSTANTS.UNIT_TEST_SHORTCUT;

describe("RepoOperationLock", () => {
  const originalShortcut = process.env[SHORTCUT];
  const originalNodeEnv = process.env.NODE_ENV;
  const release = vi.fn(async () => {});
  let gitService: Pick<GitService, "getBareRepoPath">;

  beforeEach(() => {
    vi.clearAllMocks();
    // setup.ts opts the whole worker into the no-op lock; these tests exercise the real one.
    delete process.env[SHORTCUT];
    gitService = {
      getBareRepoPath: vi.fn(() => "/tmp/bare.git"),
    };
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

    const acquired = await lock.acquire();
    await acquired?.();

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

    const acquired = await lock.acquire();

    expect(acquired).toBeTypeOf("function");
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

    await expect(lock.acquire()).resolves.toBeTypeOf("function");
    expect(lockfile.lock).toHaveBeenCalledTimes(2);
  });

  it("locks both the bare repository path and the worktreeDir lock file in worktree mode", async () => {
    const config = makeConfig();
    const worktreeTarget = getWorktreeDirLockTarget(config);
    const lock = new RepoOperationLock(config, gitService as GitService);

    const acquired = await lock.acquire();
    expect(acquired).toBeTypeOf("function");

    expect(fs.mkdir).toHaveBeenCalledWith("/tmp/bare.git", { recursive: true });
    expect(lockfile.lock).toHaveBeenCalledWith(
      "/tmp/bare.git",
      expect.objectContaining({ retries: 0, realpath: false, onCompromised: expect.any(Function) }),
    );
    expect(lockfile.lock).toHaveBeenCalledWith(
      path.join(worktreeTarget.dir, worktreeTarget.file),
      expect.objectContaining({ retries: 0, realpath: false }),
    );

    await acquired?.();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("releases the bare-repo lock and returns null when the worktreeDir lock is contended in worktree mode", async () => {
    const contended = new Error("locked") as NodeJS.ErrnoException;
    contended.code = "ELOCKED";
    (lockfile.lock as Mock).mockResolvedValueOnce(release).mockRejectedValueOnce(contended);
    const lock = new RepoOperationLock(makeConfig(), gitService as GitService);

    await expect(lock.acquire()).resolves.toBeNull();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("locks a stable clone-mode lock file", async () => {
    const config = makeConfig({
      mode: "clone",
      branch: "main",
      __configFileDir: "/tmp/config",
    });
    const target = getWorktreeDirLockTarget(config);
    const lock = new RepoOperationLock(config, gitService as GitService);

    await expect(lock.acquire()).resolves.toBe(release);

    expect(fs.mkdir).toHaveBeenCalledWith(target.dir, { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledWith(path.join(target.dir, target.file), "", { flag: "a" });
    expect(lockfile.lock).toHaveBeenCalledWith(
      path.join(target.dir, target.file),
      expect.objectContaining({ retries: 0, realpath: false }),
    );
  });

  it("returns null when another process holds the lock", async () => {
    const error = new Error("locked") as NodeJS.ErrnoException;
    error.code = "ELOCKED";
    (lockfile.lock as Mock).mockRejectedValue(error);
    const lock = new RepoOperationLock(makeConfig(), gitService as GitService);

    await expect(lock.acquire()).resolves.toBeNull();
  });

  it("returns null and warns when lock acquisition fails for a non-ELOCKED reason in worktree mode (#5)", async () => {
    const error = new Error("permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";
    (lockfile.lock as Mock).mockRejectedValue(error);
    const warn = vi.fn();
    const lock = new RepoOperationLock(makeConfig(), gitService as GitService, { warn } as unknown as Logger);

    await expect(lock.acquire()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
  });

  it("returns null and warns when lock acquisition fails for a non-ELOCKED reason in clone mode (#5)", async () => {
    const error = new Error("read-only file system") as NodeJS.ErrnoException;
    error.code = "EROFS";
    (lockfile.lock as Mock).mockRejectedValue(error);
    const warn = vi.fn();
    const config = makeConfig({ mode: "clone", branch: "main", __configFileDir: "/tmp/config" });
    const lock = new RepoOperationLock(config, gitService as GitService, { warn } as unknown as Logger);

    await expect(lock.acquire()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EROFS"));
  });
});
