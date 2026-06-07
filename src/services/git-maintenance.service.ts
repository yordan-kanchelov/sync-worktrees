import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";

import { DEFAULT_CONFIG, MAINTENANCE_CONSTANTS, PATH_CONSTANTS } from "../constants";
import { atomicWriteFile } from "../utils/atomic-write";
import { parseDuration } from "../utils/date-filter";
import { getErrorMessage } from "../utils/lfs-error";
import { REPOSITORY_MODES, resolveMode } from "../utils/repo-mode";

import { Logger } from "./logger.service";

import type { Config } from "../types";
import type { GitService } from "./git.service";
import type { SimpleGit } from "simple-git";

export interface MaintenanceState {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
}

interface MaintenanceTarget {
  /** Directory `git gc` runs in (the clone working dir, or the bare repo). */
  cwd: string;
  /** Git object-store dir that holds the persisted state file. */
  gitDir: string;
}

export type GitFactory = (cwd: string) => SimpleGit;

/**
 * Periodic `git gc` for the repository object store. Reclaims unreachable
 * objects (e.g. left by clone-mode single-branch ref narrowing and branch
 * churn) and consolidates pack files. Throttled by a persisted timestamp so a
 * daemon restart or repeated `runOnce` invocations don't re-run it every tick.
 *
 * Callers MUST already hold the repository operation lock — `runIfDueUnlocked`
 * mirrors `WorktreeSyncService.initializeUnlocked` and never re-acquires it.
 */
export class GitMaintenanceService {
  private logger: Logger;
  private gitFactory: GitFactory;

  constructor(
    private config: Config,
    private gitService: GitService,
    logger?: Logger,
    gitFactory: GitFactory = (cwd) => simpleGit(cwd),
  ) {
    this.logger = logger ?? Logger.createDefault();
    this.gitFactory = gitFactory;
  }

  updateLogger(logger: Logger): void {
    this.logger = logger;
  }

  isEnabled(): boolean {
    return this.config.maintenance?.enabled ?? DEFAULT_CONFIG.MAINTENANCE.ENABLED;
  }

  private getIntervalMs(): number {
    const fallback = parseDuration(DEFAULT_CONFIG.MAINTENANCE.INTERVAL)!;
    const raw = this.config.maintenance?.interval;
    if (raw === undefined) {
      return fallback;
    }
    const parsed = parseDuration(raw);
    if (parsed === null) {
      this.logger.warn(`Invalid maintenance.interval '${raw}', using default ${DEFAULT_CONFIG.MAINTENANCE.INTERVAL}.`);
      return fallback;
    }
    return parsed;
  }

  private resolveTarget(): MaintenanceTarget {
    if (resolveMode(this.config) === REPOSITORY_MODES.CLONE) {
      const cwd = path.resolve(this.config.worktreeDir);
      return { cwd, gitDir: path.join(cwd, PATH_CONSTANTS.GIT_DIR) };
    }
    const bare = this.gitService.getBareRepoPath();
    return { cwd: bare, gitDir: bare };
  }

  private getStatePath(gitDir: string): string {
    return path.join(gitDir, MAINTENANCE_CONSTANTS.STATE_FILENAME);
  }

  private async readState(statePath: string): Promise<MaintenanceState> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(statePath, "utf-8"));
      // Reject arrays and non-objects: spreading into a fresh plain object means a
      // corrupt file (e.g. `[]`) can't silently swallow the lastAttemptAt we set on
      // it, which would otherwise break throttling and re-run gc every sync.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {};
      }
      return { ...(parsed as MaintenanceState) };
    } catch {
      return {};
    }
  }

  private async writeState(statePath: string, state: MaintenanceState): Promise<void> {
    try {
      await atomicWriteFile(statePath, JSON.stringify(state, null, 2));
    } catch (error) {
      this.logger.warn(`Failed to persist maintenance state: ${getErrorMessage(error)}`);
    }
  }

  isDue(state: MaintenanceState, now: number): boolean {
    if (!state.lastAttemptAt) {
      return true;
    }
    const last = new Date(state.lastAttemptAt).getTime();
    if (Number.isNaN(last)) {
      return true;
    }
    return now - last >= this.getIntervalMs();
  }

  /**
   * Run `git gc` if maintenance is enabled and due. MUST be called while the
   * repository operation lock is already held. Never throws: a gc failure is
   * recorded and warned so it cannot fail the surrounding sync. The attempt
   * timestamp is persisted even on failure, so a perpetually-failing gc is
   * throttled instead of retried every tick.
   */
  async runIfDueUnlocked(now: number = Date.now()): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    // Outer guard: maintenance is best-effort and runs at the tail of sync(). Any
    // failure here — target resolution, state IO, the gc itself — must be swallowed
    // so it can never fail an otherwise-successful sync.
    try {
      const { cwd, gitDir } = this.resolveTarget();

      try {
        await fs.access(gitDir);
      } catch {
        // Repo not initialized yet — nothing to maintain.
        return;
      }

      const statePath = this.getStatePath(gitDir);
      const state = await this.readState(statePath);
      if (!this.isDue(state, now)) {
        return;
      }

      const aggressive = this.config.maintenance?.aggressive ?? false;
      const args = aggressive ? ["gc", "--prune=now"] : ["gc"];
      const nowIso = new Date(now).toISOString();
      state.lastAttemptAt = nowIso;

      this.logger.info(`🧹 Running git ${args.join(" ")} (maintenance)...`);
      try {
        await this.gitFactory(cwd).raw(args);
        state.lastSuccessAt = nowIso;
        delete state.lastError;
        this.logger.info("🧹 Maintenance complete.");
      } catch (error) {
        state.lastFailureAt = nowIso;
        state.lastError = getErrorMessage(error);
        this.logger.warn(`⚠️  Maintenance (git ${args.join(" ")}) failed: ${state.lastError}`);
      } finally {
        await this.writeState(statePath, state);
      }
    } catch (error) {
      this.logger.warn(`⚠️  Maintenance skipped due to an unexpected error: ${getErrorMessage(error)}`);
    }
  }
}
