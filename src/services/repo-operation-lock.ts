import * as fs from "fs/promises";
import * as path from "path";

import * as lockfile from "proper-lockfile";

import { DEFAULT_CONFIG, ENV_CONSTANTS } from "../constants";
import { getErrorMessage } from "../utils/lfs-error";
import { getWorktreeDirLockTarget } from "../utils/lock-path";
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
      return this.acquireWorktreeDirLock();
    }

    return this.acquireWorktreeModeLock();
  }

  private async acquireWorktreeDirLock(): Promise<RepoLockRelease | null> {
    const target = getWorktreeDirLockTarget(this.config);
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
    const releaseBare = await this.lockPath(barePath);
    if (releaseBare === null) return null;

    // The bare-repo lock alone does not serialize what this lock exists to
    // protect: every destructive operation happens under worktreeDir, and the
    // default bare path is derived per config file, so two configs can point
    // different bare repos at the same worktreeDir and both hold "their" bare
    // lock. Hold the worktreeDir-keyed lock as well.
    const releaseWorktreeDir = await this.acquireWorktreeDirLock();
    if (releaseWorktreeDir === null) {
      try {
        await releaseBare();
      } catch (releaseError) {
        this.logger.warn(
          `Failed to release bare-repo lock after worktreeDir lock contention: ${getErrorMessage(releaseError)}`,
        );
      }
      return null;
    }

    return async () => {
      try {
        await releaseWorktreeDir();
      } finally {
        await releaseBare();
      }
    };
  }

  private async lockPath(lockTarget: string): Promise<RepoLockRelease | null> {
    try {
      return await lockfile.lock(lockTarget, {
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
