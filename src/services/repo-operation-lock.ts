import * as fs from "fs/promises";
import * as path from "path";

import * as lockfile from "proper-lockfile";

import { DEFAULT_CONFIG } from "../constants";
import { getErrorMessage } from "../utils/lfs-error";
import { getWorktreeDirLockTarget } from "../utils/lock-path";
import { REPOSITORY_MODES, resolveMode } from "../utils/repo-mode";
import { isUnitTestShortcutEnabled } from "../utils/unit-test-shortcut";

import { Logger } from "./logger.service";

import type { Config, RepoLockUnavailable } from "../types";
import type { GitService } from "./git.service";

export type RepoLockRelease = () => Promise<void>;

// `locked` is contention (proper-lockfile's ELOCKED: another process holds the
// lock) and a clean skip. `lock_unavailable` is everything else — the lock
// directory or file could not be prepared or locked — and must surface as a
// failure with its cause, never as "another process holds the lock".
export type RepoLockAcquireResult =
  | { acquired: true; release: RepoLockRelease }
  | { acquired: false; reason: "locked" }
  | ({ acquired: false } & RepoLockUnavailable);

export class RepoOperationLock {
  constructor(
    private config: Config,
    private gitService: GitService,
    private logger: Logger = Logger.createDefault(),
  ) {}

  updateLogger(logger: Logger): void {
    this.logger = logger;
  }

  async acquire(): Promise<RepoLockAcquireResult> {
    if (isUnitTestShortcutEnabled()) {
      return { acquired: true, release: async () => {} };
    }

    if (resolveMode(this.config) === REPOSITORY_MODES.CLONE) {
      return this.acquireWorktreeDirLock();
    }

    return this.acquireWorktreeModeLock();
  }

  private async acquireWorktreeDirLock(): Promise<RepoLockAcquireResult> {
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
    return this.lockPath(lockTarget);
  }

  private async acquireWorktreeModeLock(): Promise<RepoLockAcquireResult> {
    const barePath = this.gitService.getBareRepoPath();
    try {
      await fs.mkdir(barePath, { recursive: true });
    } catch (error) {
      return this.unavailable("prepare the bare repository directory for locking", barePath, error);
    }
    const bare = await this.lockPath(barePath);
    if (!bare.acquired) return bare;

    // The bare-repo lock alone does not serialize what this lock exists to
    // protect: every destructive operation happens under worktreeDir, and the
    // default bare path is derived per config file, so two configs can point
    // different bare repos at the same worktreeDir and both hold "their" bare
    // lock. Hold the worktreeDir-keyed lock as well.
    const worktreeDir = await this.acquireWorktreeDirLock();
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

  private async lockPath(lockTarget: string): Promise<RepoLockAcquireResult> {
    try {
      const release = await lockfile.lock(lockTarget, {
        stale: DEFAULT_CONFIG.LOCK_STALE_MS,
        update: DEFAULT_CONFIG.LOCK_UPDATE_MS,
        retries: 0,
        realpath: false,
        // proper-lockfile's default onCompromised throws from inside its
        // refresh timer — uncatchable by any caller, so it would take down
        // the whole multi-repo process mid-operation. Losing the lock only
        // means another process may start concurrently, the lesser harm:
        // finish the in-flight operation and say so.
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
      // EACCES/EROFS/EPERM surfaced at lock time rather than during prep.
      return this.unavailable("acquire the repo lock", lockTarget, error);
    }
  }

  // A lock this process cannot take (read-only FS, ENOSPC, EACCES, a state
  // dir that is a file) must never crash the whole multi-repo run, but it is
  // not contention either: nothing was synced and no other process is
  // responsible. Name the path and errno here, where the cause is known, and
  // hand the caller a typed reason so it reports a failure, not a skip.
  private unavailable(what: string, lockPath: string, error: unknown): RepoLockAcquireResult {
    const code = (error as NodeJS.ErrnoException).code;
    const message = getErrorMessage(error);
    this.logger.warn(
      `Could not ${what} at '${lockPath}' (${code ?? "unknown"}: ${message}); the repository lock is unavailable.`,
    );
    return { acquired: false, reason: "lock_unavailable", path: lockPath, code, error: message };
  }
}
