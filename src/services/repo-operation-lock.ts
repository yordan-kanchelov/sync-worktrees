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

export interface RepoLockAcquireOptions {
  /**
   * How long to keep retrying a lock another process already holds, in
   * milliseconds. 0 (the default) keeps the fail-fast behaviour every periodic
   * caller depends on: a cron tick that cannot take the lock is a clean skip,
   * because whoever holds it is doing the same work.
   *
   * A non-zero budget is for the opposite case — an explicit, one-shot user
   * command (a trash restore or purge) where "the daemon is mid-sync" is not a
   * reason to give up. It is a BUDGET, not "wait for it": the window is an
   * absolute deadline shared by both locks a worktree-mode repo takes, so the
   * whole acquire is bounded by it however the time is spent, and a scripted
   * or non-interactive run always terminates.
   */
  waitMs?: number;
}

// Fixed-interval retry rather than proper-lockfile's exponential default, so
// the budget above is the wall clock a caller can quote to a user.
const LOCK_RETRY_INTERVAL_MS = 1000;

// `retries: 0` — the literal proper-lockfile default — for every caller without
// a budget, so the no-wait path is byte-for-byte what it has always been and
// stays a single failed attempt rather than a retry loop with a zero count.
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

    // An absolute deadline, resolved once here: worktree mode takes two locks
    // one after the other, and a per-lock budget would double the worst case.
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

    // The bare-repo lock alone does not serialize what this lock exists to
    // protect: every destructive operation happens under worktreeDir, and the
    // default bare path is derived per config file, so two configs can point
    // different bare repos at the same worktreeDir and both hold "their" bare
    // lock. Hold the worktreeDir-keyed lock as well.
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

  // A lock this process cannot take (read-only FS, ENOSPC, EACCES, a lock
  // dir that is a file) must never crash the whole multi-repo run, but it is
  // not contention either: nothing was synced and no other process is
  // responsible. Name the path and errno here, where the cause is known, and
  // hand the caller a typed reason so it reports a failure, not a skip.
  private unavailable(what: string, lockPath: string, error: unknown): RepoLockAcquireResult {
    const code = (error as NodeJS.ErrnoException).code;
    const message = getErrorMessage(error);
    this.logger.warn(
      `Could not ${what} at '${lockPath}' (${code ?? "unknown"}: ${message}); the repository lock is unavailable. Set SYNC_WORKTREES_LOCK_DIR to a writable directory, identically for every process syncing this worktreeDir.`,
    );
    return { acquired: false, reason: "lock_unavailable", path: lockPath, code, error: message };
  }
}
