import * as fs from "fs/promises";
import * as path from "path";

import * as lockfile from "proper-lockfile";

import { DEFAULT_CONFIG, ENV_CONSTANTS } from "../constants";
import { getErrorMessage } from "../utils/lfs-error";
import { getCloneModeLockTarget } from "../utils/lock-path";
import { REPOSITORY_MODES, resolveMode } from "../utils/repo-mode";

import { Logger } from "./logger.service";

import type { Config } from "../types";
import type { GitService } from "./git.service";

export type RepoLockRelease = () => Promise<void>;

export class RepoOperationLock {
  constructor(
    private config: Config,
    private gitService: GitService,
    private logger: Logger = Logger.createDefault(),
  ) {}

  updateLogger(logger: Logger): void {
    this.logger = logger;
  }

  async acquire(): Promise<RepoLockRelease | null> {
    if (process.env.NODE_ENV === ENV_CONSTANTS.NODE_ENV_TEST) {
      return async () => {};
    }

    if (resolveMode(this.config) === REPOSITORY_MODES.CLONE) {
      return this.acquireCloneModeLock();
    }

    return this.acquireWorktreeModeLock();
  }

  private async acquireCloneModeLock(): Promise<RepoLockRelease | null> {
    const target = getCloneModeLockTarget(this.config);
    const lockTarget = path.join(target.dir, target.file);
    try {
      await fs.mkdir(target.dir, { recursive: true });
      await fs.writeFile(lockTarget, "", { flag: "a" });
    } catch {
      // Couldn't prepare the lock target (read-only FS, ENOSPC, EACCES).
      // Treat as 'unable to acquire' so the operation is skipped cleanly
      // instead of crashing the whole sync run.
      return null;
    }
    return this.lockPath(lockTarget);
  }

  private async acquireWorktreeModeLock(): Promise<RepoLockRelease | null> {
    const barePath = this.gitService.getBareRepoPath();
    try {
      await fs.mkdir(barePath, { recursive: true });
    } catch {
      return null;
    }
    return this.lockPath(barePath);
  }

  private async lockPath(lockTarget: string): Promise<RepoLockRelease | null> {
    try {
      return await lockfile.lock(lockTarget, {
        stale: DEFAULT_CONFIG.LOCK_STALE_MS,
        update: DEFAULT_CONFIG.LOCK_UPDATE_MS,
        retries: 0,
        realpath: false,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOCKED") {
        return null;
      }
      // A lock we cannot acquire (read-only FS, EACCES/EROFS/EPERM surfaced at
      // lock time rather than during prep) must be a clean skip, never a fatal
      // error that crashes the whole multi-repo run. Surface it as a warning so
      // the cause is visible.
      this.logger.warn(
        `Could not acquire repo lock at '${lockTarget}' (${code ?? "unknown"}: ${getErrorMessage(error)}); skipping.`,
      );
      return null;
    }
  }
}
