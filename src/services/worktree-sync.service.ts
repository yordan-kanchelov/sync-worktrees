import { getErrorMessage } from "../utils/lfs-error";
import { REPOSITORY_MODES, resolveMode } from "../utils/repo-mode";
import { retry } from "../utils/retry";
import { PhaseTimer, Timer, formatTimingTable } from "../utils/timing";

import { type CloneSkipReason, CloneSyncService } from "./clone-sync.service";
import { GitService } from "./git.service";
import { Logger } from "./logger.service";
import { ProgressEmitter } from "./progress-emitter";
import { RepoOperationLock } from "./repo-operation-lock";
import { SyncOutcomeAccumulator } from "./sync-outcome";
import { SyncRetryPolicy } from "./sync-retry-policy";
import { WorktreeModeSyncRunner } from "./worktree-mode-sync-runner";

import type { ProgressEvent, ProgressListener } from "./progress-emitter";
import type { RepoLockRelease } from "./repo-operation-lock";
import type { Config, SyncOutcome, SyncResult } from "../types";
import type { LfsErrorContext } from "../utils/retry";

export type { ProgressEvent, ProgressListener } from "./progress-emitter";
export type { SyncOutcome, SyncOutcomeAction, SyncOutcomeCounts, SyncResult } from "../types";

export type ExclusiveRepoOperationResult<T> =
  | { started: true; value: T }
  | { started: false; reason: "in_progress" | "locked" };

export class WorktreeSyncService {
  private gitService: GitService;
  private cloneSyncService: CloneSyncService | null = null;
  private logger: Logger;
  private syncInProgress: boolean = false;
  private progressEmitter = new ProgressEmitter();
  private repoOperationLock: RepoOperationLock;
  private retryPolicy: SyncRetryPolicy;
  private worktreeModeSyncRunner: WorktreeModeSyncRunner;
  private skipsAccumulator: CloneSkipReason[] = [];
  private lastOutcome: SyncOutcome | null = null;

  constructor(public readonly config: Config) {
    this.logger = config.logger ?? Logger.createDefault(undefined, config.debug);
    this.gitService = new GitService(config, this.logger);
    this.repoOperationLock = new RepoOperationLock(config, this.gitService, this.logger);
    this.retryPolicy = new SyncRetryPolicy(config, this.gitService, this.logger);
    this.worktreeModeSyncRunner = new WorktreeModeSyncRunner(
      config,
      this.gitService,
      this.logger,
      this.progressEmitter,
    );
    if (resolveMode(config) === REPOSITORY_MODES.CLONE) {
      this.cloneSyncService = new CloneSyncService(config, this.gitService, this.logger, {
        progressEmitter: (event): void => this.emitProgress(event),
        onSkip: (reason): void => {
          this.skipsAccumulator.push(reason);
        },
      });
    }
  }

  public getRecordedSkips(): readonly CloneSkipReason[] {
    return [...this.skipsAccumulator];
  }

  public clearRecordedSkips(): void {
    this.skipsAccumulator = [];
  }

  public clearPendingInitSkip(): void {
    this.cloneSyncService?.clearPendingInitSkip();
  }

  public getLastOutcome(): SyncOutcome | null {
    return this.lastOutcome;
  }

  isCloneMode(): boolean {
    return this.cloneSyncService !== null;
  }

  async getWorktrees(): Promise<Array<{ path: string; branch: string }>> {
    if (this.cloneSyncService) {
      return this.cloneSyncService.getWorktrees();
    }
    return this.gitService.getWorktrees();
  }

  async initialize(): Promise<void> {
    if (this.isInitialized()) return;
    const result = await this.runExclusiveRepoOperation(() => this.initializeUnlocked());
    if (!result.started) {
      const reason = result.reason === "in_progress" ? "operation in progress" : "another process holds the lock";
      this.logger.warn(`⚠️  Initialize skipped: ${reason}`);
    }
  }

  async initializeUnlocked(outcome?: SyncOutcomeAccumulator): Promise<void> {
    this.emitProgress({ phase: "initialize", message: "Initializing repository" });
    if (this.cloneSyncService) {
      await this.cloneSyncService.initialize(outcome);
    } else {
      await this.gitService.initialize();
    }
    this.emitProgress({ phase: "initialize", message: "Repository initialized" });
  }

  isInitialized(): boolean {
    if (this.cloneSyncService) {
      return this.cloneSyncService.isInitialized();
    }
    return this.gitService.isInitialized();
  }

  isSyncInProgress(): boolean {
    return this.syncInProgress;
  }

  getGitService(): GitService {
    return this.gitService;
  }

  updateLogger(logger: Logger): void {
    this.logger = logger;
    this.gitService.updateLogger(logger);
    this.cloneSyncService?.updateLogger(logger);
    this.retryPolicy.updateLogger(logger);
    this.worktreeModeSyncRunner.updateLogger(logger);
    this.repoOperationLock.updateLogger(logger);
  }

  onProgress(listener: ProgressListener): () => void {
    return this.progressEmitter.onProgress(listener);
  }

  async runExclusiveRepoOperation<T>(operation: () => Promise<T>): Promise<ExclusiveRepoOperationResult<T>> {
    if (this.syncInProgress) {
      this.logger.warn("⚠️  Another repository operation is already in progress, skipping...");
      return { started: false, reason: "in_progress" };
    }
    // Claim the in-process slot synchronously so a second caller arriving while
    // we await acquire() sees "in_progress" instead of also passing the check.
    this.syncInProgress = true;

    let release: RepoLockRelease | null;
    try {
      release = await this.repoOperationLock.acquire();
    } catch (error) {
      this.syncInProgress = false;
      throw error;
    }

    if (release === null) {
      this.syncInProgress = false;
      this.logger.warn("⚠️  Another process holds the sync lock for this repo, skipping...");
      return { started: false, reason: "locked" };
    }

    try {
      return { started: true, value: await operation() };
    } finally {
      // Release the file lock first; only then clear the in-process flag so
      // another caller arriving in this window gets "in_progress" rather than
      // ELOCKED from proper-lockfile.
      try {
        await release();
      } catch (releaseError) {
        this.logger.warn(`Failed to release sync lock: ${getErrorMessage(releaseError)}`);
      }
      this.syncInProgress = false;
    }
  }

  private emitProgress(event: ProgressEvent): void {
    this.progressEmitter.emit(event);
  }

  async sync(): Promise<SyncResult> {
    const result = await this.runExclusiveRepoOperation<SyncOutcome>(async () => {
      const totalTimer = new Timer();
      const phaseTimer = new PhaseTimer();
      const outcome = new SyncOutcomeAccumulator({
        mode: this.cloneSyncService ? "clone" : "worktree",
        repoName: (this.config as { name?: string }).name,
      });
      const syncContext = this.retryPolicy.createContext();
      const retryOptions = this.retryPolicy.createOptions(syncContext);
      let durationMs: number | undefined;

      try {
        if (!this.isInitialized()) {
          await this.initializeUnlocked(outcome);
        }

        this.logger.info(`[${new Date().toISOString()}] Starting worktree synchronization...`);

        const retryOutcomeBaseline = outcome.snapshot();
        const retryOptionsWithOutcomeReset = {
          ...retryOptions,
          onRetry: (error: unknown, attempt: number, context?: LfsErrorContext): void => {
            outcome.restore(retryOutcomeBaseline);
            retryOptions.onRetry?.(error, attempt, context);
          },
        };

        const cloneSync = this.cloneSyncService;
        if (cloneSync) {
          await retry(() => cloneSync.runSyncAttempt(outcome), retryOptionsWithOutcomeReset);
        } else {
          await retry(
            () => this.worktreeModeSyncRunner.runSyncAttempt(phaseTimer, syncContext, outcome),
            retryOptionsWithOutcomeReset,
          );
        }
      } catch (error) {
        if (outcome.getCounts().failed === 0) {
          outcome.recordFailed("repo", getErrorMessage(error), { reason: "sync_failed" });
        }
        this.logger.error("\n❌ Error during worktree synchronization after all retry attempts:", error);
        throw error;
      } finally {
        this.retryPolicy.resetLfsSkipIfNeeded(syncContext);
        this.logger.info(`[${new Date().toISOString()}] Synchronization finished.\n`);
        durationMs = totalTimer.stop();
        this.lastOutcome = outcome.toOutcome(durationMs);

        if (this.config.debug) {
          const phaseResults = phaseTimer.getResults();
          const repoName = (this.config as { name?: string }).name;
          this.logger.table(formatTimingTable(durationMs, phaseResults, repoName));
        }
      }

      return this.lastOutcome ?? outcome.toOutcome(durationMs);
    });

    return result.started ? { started: true, outcome: result.value } : result;
  }
}
