import * as fs from "fs/promises";
import * as path from "path";

import { DEFAULT_CONFIG, MAINTENANCE_CONSTANTS, PATH_CONSTANTS } from "../constants";
import { atomicWriteFile } from "../utils/atomic-write";
import { parseDuration } from "../utils/date-filter";
import { createGitClient } from "../utils/git-client";
import { getErrorMessage } from "../utils/errors";
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
  cwd: string;
  gitDir: string;
}

export type GitFactory = (cwd: string) => SimpleGit;

export type MaintenanceTargetGuard = () => Promise<void>;

export class GitMaintenanceService {
  private logger: Logger;
  private gitFactory: GitFactory;
  private targetGuard?: MaintenanceTargetGuard;

  constructor(
    private config: Config,
    private gitService: GitService,
    logger?: Logger,
    gitFactory: GitFactory = (cwd) => createGitClient(cwd),
  ) {
    this.logger = logger ?? Logger.createDefault();
    this.gitFactory = gitFactory;
  }

  updateLogger(logger: Logger): void {
    this.logger = logger;
  }

  setTargetGuard(guard: MaintenanceTargetGuard): void {
    this.targetGuard = guard;
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
    if (parsed === null || parsed <= 0) {
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

  async runIfDueUnlocked(now: number = Date.now()): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    await this.runUnlocked(now, false);
  }

  async runNowUnlocked(now: number = Date.now()): Promise<boolean> {
    return this.runUnlocked(now, true);
  }

  private buildArgs(forcePrune: boolean): string[] {
    if (this.config.maintenance?.aggressive ?? false) return ["gc", "--prune=now"];
    if (forcePrune) return ["gc", `--prune=${MAINTENANCE_CONSTANTS.FORCE_CLEAN_PRUNE_EXPIRE}`];
    return ["gc"];
  }

  private async runUnlocked(now: number, forcePrune: boolean): Promise<boolean> {
    try {
      const { cwd, gitDir } = this.resolveTarget();

      try {
        await fs.access(gitDir);
      } catch {
        return false;
      }

      if (this.targetGuard) {
        try {
          await this.targetGuard();
        } catch (error) {
          this.logger.warn(`🧹 Skipping git gc: '${cwd}' is not a repository this tool manages.`);
          this.logger.debug(getErrorMessage(error));
          return false;
        }
      }

      const statePath = this.getStatePath(gitDir);
      const state = await this.readState(statePath);
      if (!forcePrune && !this.isDue(state, now)) {
        return false;
      }

      const args = this.buildArgs(forcePrune);
      const nowIso = new Date(now).toISOString();
      state.lastAttemptAt = nowIso;

      this.logger.info(`🧹 Running git ${args.join(" ")} (maintenance)...`);
      try {
        await this.gitFactory(cwd).raw(args);
        state.lastSuccessAt = nowIso;
        delete state.lastError;
        this.logger.info("🧹 Maintenance complete.");
        return true;
      } catch (error) {
        state.lastFailureAt = nowIso;
        state.lastError = getErrorMessage(error);
        this.logger.warn(`⚠️  Maintenance (git ${args.join(" ")}) failed: ${state.lastError}`);
        return false;
      } finally {
        await this.writeState(statePath, state);
      }
    } catch (error) {
      this.logger.warn(`⚠️  Maintenance skipped due to an unexpected error: ${getErrorMessage(error)}`);
      return false;
    }
  }
}
