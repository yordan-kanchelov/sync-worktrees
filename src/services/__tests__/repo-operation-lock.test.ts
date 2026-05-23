import * as fs from "fs/promises";
import * as path from "path";

import * as lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getCloneModeLockTarget } from "../../utils/lock-path";
import { RepoOperationLock } from "../repo-operation-lock";

import type { Config } from "../../types";
import type { GitService } from "../git.service";
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

describe("RepoOperationLock", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const release = vi.fn(async () => {});
  let gitService: Pick<GitService, "getBareRepoPath">;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "production";
    gitService = {
      getBareRepoPath: vi.fn(() => "/tmp/bare.git"),
    };
    (fs.mkdir as Mock).mockResolvedValue(undefined);
    (fs.writeFile as Mock).mockResolvedValue(undefined);
    (lockfile.lock as Mock).mockResolvedValue(release);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("returns a no-op release in test environment", async () => {
    process.env.NODE_ENV = "test";
    const lock = new RepoOperationLock(makeConfig(), gitService as GitService);

    const acquired = await lock.acquire();
    await acquired?.();

    expect(lockfile.lock).not.toHaveBeenCalled();
  });

  it("locks the bare repository path in worktree mode", async () => {
    const lock = new RepoOperationLock(makeConfig(), gitService as GitService);

    await expect(lock.acquire()).resolves.toBe(release);

    expect(fs.mkdir).toHaveBeenCalledWith("/tmp/bare.git", { recursive: true });
    expect(lockfile.lock).toHaveBeenCalledWith(
      "/tmp/bare.git",
      expect.objectContaining({ retries: 0, realpath: false }),
    );
  });

  it("locks a stable clone-mode lock file", async () => {
    const config = makeConfig({
      mode: "clone",
      branch: "main",
      __configFileDir: "/tmp/config",
    });
    const target = getCloneModeLockTarget(config);
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
});
