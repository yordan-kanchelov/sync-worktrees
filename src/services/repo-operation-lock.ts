import * as fs from "fs/promises";
import * as path from "path";

import * as lockfile from "proper-lockfile";

import { DEFAULT_CONFIG } from "../constants";
import { getErrorMessage } from "../utils/errors";
import { getWorktreeDirLockTarget } from "../utils/lock-path";
import { REPOSITORY_MODES, resolveMode } from "../utils/repo-mode";
import { isUnitTestShortcutEnabled } from "../utils/unit-test-shortcut";

import { Logger } from "./logger.service";

import type { Config, RepoLockUnavailable } from "../types";
import type { GitService } from "./git.service";

export type RepoLockRelease = () => Promise<void>;

export type RepoLockAcquireResult =
  | { acquired: true; release: RepoLockRelease }
  | { acquired: false; reason: "locked" }
  | ({ acquired: false } & RepoLockUnavailable);

export interface RepoLockAcquireOptions {
  waitMs?: number;
}

const LOCK_RETRY_INTERVAL_MS = 1000;

function retriesUntil(
  deadline: number,
): number | { retries: number; factor: number; minTimeout: number; maxTimeout: number } {
  const remainingMs = deadline > 0 ? deadline - Date.now() : 0;
  if (remainingMs <= 0) return 0;
  return {
    retries: Math.ceil(remainingMs / LOCK_RETRY_INTERVAL_MS),
    factor: 1,
    minTimeout: LOCK_RETRY_INTERVAL_MS,
    maxTimeout: LOCK_RETRY_INTERVAL_MS,
  };
}

export class RepoOperationLock {
  constructor(
    private config: Config,
    private gitService: GitService,
    private logger: Logger = Logger.createDefault(),
  ) {}

  updateLogger(logger: Logger): void {
    this.logger = logger;
  }

  async acquire(options: RepoLockAcquireOptions = {}): Promise<RepoLockAcquireResult> {
    if (isUnitTestShortcutEnabled()) {
      return { acquired: true, release: async () => {} };
    }

    const waitMs = options.waitMs ?? 0;
    const deadline = waitMs > 0 ? Date.now() + waitMs : 0;

    if (resolveMode(this.config) === REPOSITORY_MODES.CLONE) {
      return this.acquireWorktreeDirLock(deadline);
    }

    return this.acquireWorktreeModeLock(deadline);
  }

  private async acquireWorktreeDirLock(deadline: number): Promise<RepoLockAcquireResult> {
    const target = getWorktreeDirLockTarget(this.config);
    const lockTarget = path.join(target.dir, target.file);
    try {
      await fs.mkdir(target.dir, { recursive: true });
    } catch (error) {
      return this.unavailable("prepare the repo lock directory", target.dir, error);
    }
    try {
      await fs.writeFile(lockTarget, "", { flag: "a" });
    } catch (error) {
      return this.unavailable("create the repo lock file", lockTarget, error);
    }
    return this.lockPath(lockTarget, deadline);
  }

  private async acquireWorktreeModeLock(deadline: number): Promise<RepoLockAcquireResult> {
    const barePath = this.gitService.getBareRepoPath();
    try {
      await fs.mkdir(barePath, { recursive: true });
    } catch (error) {
      return this.unavailable("prepare the bare repository directory for locking", barePath, error);
    }
    const bare = await this.lockPath(barePath, deadline);
    if (!bare.acquired) return bare;

    const worktreeDir = await this.acquireWorktreeDirLock(deadline);
    if (!worktreeDir.acquired) {
      try {
        await bare.release();
      } catch (releaseError) {
        this.logger.warn(
          `Failed to release bare-repo lock after the worktreeDir lock could not be taken: ${getErrorMessage(releaseError)}`,
        );
      }
      return worktreeDir;
    }

    return {
      acquired: true,
      release: async () => {
        try {
          await worktreeDir.release();
        } finally {
          await bare.release();
        }
      },
    };
  }

  private async lockPath(lockTarget: string, deadline: number): Promise<RepoLockAcquireResult> {
    try {
      const release = await lockfile.lock(lockTarget, {
        stale: DEFAULT_CONFIG.LOCK_STALE_MS,
        update: DEFAULT_CONFIG.LOCK_UPDATE_MS,
        retries: retriesUntil(deadline),
        realpath: false,
        onCompromised: (compromiseError: Error): void => {
          this.logger.warn(
            `Repo lock at '${lockTarget}' was compromised (${getErrorMessage(compromiseError)}); ` +
              `continuing the in-flight operation — another process may acquire the lock until it finishes.`,
          );
        },
      });
      return { acquired: true, release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
        return { acquired: false, reason: "locked" };
      }
      return this.unavailable("acquire the repo lock", lockTarget, error);
    }
  }

  private unavailable(what: string, lockPath: string, error: unknown): RepoLockAcquireResult {
    const code = (error as NodeJS.ErrnoException).code;
    const message = getErrorMessage(error);
    this.logger.warn(
      `Could not ${what} at '${lockPath}' (${code ?? "unknown"}: ${message}); the repository lock is unavailable. Set SYNC_WORKTREES_LOCK_DIR to a writable directory, identically for every process syncing this worktreeDir.`,
    );
    return { acquired: false, reason: "lock_unavailable", path: lockPath, code, error: message };
  }
}
