import pLimit from "p-limit";

import { ENV_CONSTANTS } from "../constants";
import { ConfigError } from "../errors";
import { getErrorMessage } from "../utils/lfs-error";
import { getRemovalAuditLogPath } from "../utils/lock-path";
import { REPOSITORY_MODES, resolveMode } from "../utils/repo-mode";
import { retry } from "../utils/retry";
import { PhaseTimer, Timer, formatTimingTable } from "../utils/timing";

import { type CloneSkipReason, CloneSyncService } from "./clone-sync.service";
import { GitMaintenanceService } from "./git-maintenance.service";
import { GitService } from "./git.service";
import { Logger } from "./logger.service";
import { ProgressEmitter } from "./progress-emitter";
import { RemovalAuditService } from "./removal-audit.service";
import { RepoOperationLock } from "./repo-operation-lock";
import { SyncOutcomeAccumulator } from "./sync-outcome";
import { SyncRetryPolicy } from "./sync-retry-policy";
import { TrashMigrationService } from "./trash-migration.service";
import { TrashReaperService } from "./trash-reaper.service";
import { TrashService } from "./trash.service";
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
  // In-process FIFO serializer for all bare-repo-mutating operations (sync, init,
  // interactive create). One per repo. wait:true callers queue behind an in-flight op;
  // wait:false callers fail fast. The cross-process file lock (RepoOperationLock) is
  // acquired inside the mutex body for multi-process safety.
  private repoMutex = pLimit(1);
  private progressEmitter = new ProgressEmitter();
  private repoOperationLock: RepoOperationLock;
  private maintenanceService: GitMaintenanceService;
  private retryPolicy: SyncRetryPolicy;
  private worktreeModeSyncRunner: WorktreeModeSyncRunner;
  private trashService: TrashService;
  private trashReaper: TrashReaperService;
  private trashMigration: TrashMigrationService;
  private skipsAccumulator: CloneSkipReason[] = [];
  private lastOutcome: SyncOutcome | null = null;

  constructor(public readonly config: Config) {
    this.logger = config.logger ?? Logger.createDefault(undefined, config.debug);
    this.gitService = new GitService(config, this.logger, (event): void => this.emitProgress(event));
    this.repoOperationLock = new RepoOperationLock(config, this.gitService, this.logger);
    this.maintenanceService = new GitMaintenanceService(config, this.gitService, this.logger);
    this.retryPolicy = new SyncRetryPolicy(config, this.gitService, this.logger);
    const removalAudit = new RemovalAuditService(getRemovalAuditLogPath(config));
    this.trashService = new TrashService(config, this.gitService, this.logger, removalAudit);
    this.trashReaper = new TrashReaperService(config, this.trashService, this.logger, removalAudit, this.gitService);
    this.trashMigration = new TrashMigrationService(config, this.trashService, this.logger);
    if (this.trashService.isEnabled()) {
      this.gitService.setStaleDirectoryTrasher(
        async (dirPath) => (await this.trashService.trashDirectory({ dirPath, reason: "orphan" })).payloadPath,
      );
    }
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

  async getRemoteBranches(): Promise<string[]> {
    if (this.cloneSyncService) {
      return this.cloneSyncService.getRemoteBranches();
    }
    return this.gitService.getRemoteBranches();
  }

  async checkoutBranch(branchName: string): Promise<void> {
    if (!this.cloneSyncService) {
      throw new ConfigError("checkoutBranch is only available for clone-mode repositories", "CLONE_MODE_REQUIRED");
    }
    await this.cloneSyncService.checkoutBranch(branchName);
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
    return this.repoMutex.activeCount + this.repoMutex.pendingCount > 0;
  }

  getGitService(): GitService {
    return this.gitService;
  }

  getTrashService(): TrashService {
    return this.trashService;
  }

  updateLogger(logger: Logger): void {
    this.logger = logger;
    this.gitService.updateLogger(logger);
    this.cloneSyncService?.updateLogger(logger);
    this.retryPolicy.updateLogger(logger);
    this.worktreeModeSyncRunner.updateLogger(logger);
    this.repoOperationLock.updateLogger(logger);
    this.maintenanceService.updateLogger(logger);
    this.trashService.updateLogger(logger);
    this.trashReaper.updateLogger(logger);
    this.trashMigration.updateLogger(logger);
  }

  // Runs git gc when due, inside the already-held repo lock (mirrors
  // initializeUnlocked — must NOT re-acquire runExclusiveRepoOperation or it
  // would self-deadlock/skip). Skipped under NODE_ENV=test so unit suites don't
  // shell out to real git; GitMaintenanceService is covered by its own tests.
  private async runMaintenanceIfDueUnlocked(): Promise<void> {
    if (process.env.NODE_ENV === ENV_CONSTANTS.NODE_ENV_TEST) {
      return;
    }
    await this.maintenanceService.runIfDueUnlocked();
  }

  // Same contract as runMaintenanceIfDueUnlocked: tail of a successful sync,
  // inside the held lock, never fails the sync. Runs before gc so freshly
  // reaped pin refs can be collected in the same maintenance window.
  private async runTrashMaintenanceUnlocked(): Promise<void> {
    if (process.env.NODE_ENV === ENV_CONSTANTS.NODE_ENV_TEST) {
      return;
    }
    if (this.cloneSyncService) {
      return;
    }
    try {
      await this.trashMigration.migrateLegacyUnlocked();
      await this.trashReaper.reapExpiredUnlocked();
    } catch (error) {
      this.logger.warn(`⚠️ Trash maintenance failed: ${getErrorMessage(error)}`);
    }
  }

  onProgress(listener: ProgressListener): () => void {
    return this.progressEmitter.onProgress(listener);
  }

  async runExclusiveRepoOperation<T>(
    operation: () => Promise<T>,
    options: { wait?: boolean } = {},
  ): Promise<ExclusiveRepoOperationResult<T>> {
    // Fail-fast callers (sync, init, MCP) bail when any repo op is active or queued.
    // wait:true callers (interactive create) skip this check and queue on the mutex,
    // running once the in-flight op releases. The count check and the repoMutex()
    // enqueue below execute synchronously with no await between them, so on the
    // single JS thread a second fail-fast caller always observes the first.
    if (!options.wait && this.repoMutex.activeCount + this.repoMutex.pendingCount > 0) {
      this.logger.warn("⚠️  Another repository operation is already in progress, skipping...");
      return { started: false, reason: "in_progress" };
    }

    return this.repoMutex(async (): Promise<ExclusiveRepoOperationResult<T>> => {
      const release: RepoLockRelease | null = await this.repoOperationLock.acquire();
      if (release === null) {
        this.logger.warn("⚠️  Another process holds the sync lock for this repo, skipping...");
        return { started: false, reason: "locked" };
      }

      try {
        return { started: true, value: await operation() };
      } finally {
        try {
          await release();
        } catch (releaseError) {
          this.logger.warn(`Failed to release sync lock: ${getErrorMessage(releaseError)}`);
        }
      }
    });
  }

  // Interactive variant: queues behind any in-flight sync/op instead of failing fast.
  async runQueuedRepoOperation<T>(operation: () => Promise<T>): Promise<ExclusiveRepoOperationResult<T>> {
    return this.runExclusiveRepoOperation(operation, { wait: true });
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

      await this.runTrashMaintenanceUnlocked();
      await this.runMaintenanceIfDueUnlocked();

      return this.lastOutcome ?? outcome.toOutcome(durationMs);
    });

    return result.started ? { started: true, outcome: result.value } : result;
  }
}
