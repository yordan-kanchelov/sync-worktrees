import * as fs from "fs/promises";
import * as path from "path";

import pLimit from "p-limit";

import { ENV_CONSTANTS, GIT_CONSTANTS, PATH_CONSTANTS } from "../constants";
import { ConfigError, TrashOperationError } from "../errors";
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
import type { TrashEntry, TrashManifest } from "./trash.service";
import type { Config, ForceCleanPreview, ForceCleanResult, SyncOutcome, SyncResult } from "../types";
import type { LfsErrorContext } from "../utils/retry";

export type { ProgressEvent, ProgressListener } from "./progress-emitter";
export type { SyncOutcome, SyncOutcomeAction, SyncOutcomeCounts, SyncResult } from "../types";

export type ExclusiveRepoOperationResult<T> =
  | { started: true; value: T }
  | {
      started: false;
      reason: "in_progress" | "locked";
    };

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
  private removalAudit: RemovalAuditService;
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
    this.removalAudit = new RemovalAuditService(getRemovalAuditLogPath(config));
    this.trashService = new TrashService(config, this.gitService, this.logger, this.removalAudit);
    this.trashReaper = new TrashReaperService(
      config,
      this.trashService,
      this.logger,
      this.removalAudit,
      this.gitService,
    );
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
      {
        trashService: this.trashService,
        removalAudit: this.removalAudit,
      },
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

  async checkoutBranch(branchName: string, options: { allowConfigDrift?: boolean } = {}): Promise<void> {
    if (!this.cloneSyncService) {
      throw new ConfigError("checkoutBranch is only available for clone-mode repositories", "CLONE_MODE_REQUIRED");
    }
    await this.cloneSyncService.checkoutBranch(branchName, options);
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

  async getDefaultBranch(): Promise<string> {
    if (this.cloneSyncService) {
      return this.cloneSyncService.resolveBranch();
    }
    return this.gitService.getDefaultBranch();
  }

  // Restore must hold the repo lock: the reaper, prune, and gc all mutate the
  // same trash entries and refs at the tail of a sync. wait:true queues behind
  // an in-flight sync instead of failing fast — restores are explicit user
  // actions, not periodic work.
  async restoreFromTrash(id: string): Promise<TrashManifest> {
    const result = await this.runExclusiveRepoOperation(() => this.trashService.restore(id), { wait: true });
    if (!result.started) {
      throw new TrashOperationError(
        "restore",
        `cannot restore trash entry '${id}': another process holds the repo lock`,
      );
    }
    return result.value;
  }

  async listTrashEntries(): Promise<{ entries: TrashEntry[]; invalid: string[] }> {
    return this.trashService.listEntries();
  }

  async listKeepRefs(): Promise<string[]> {
    return this.gitService.listRefs(GIT_CONSTANTS.KEEP_REF_PREFIX);
  }

  async getForceCleanPreview(): Promise<ForceCleanPreview> {
    await this.requireForceCleanTarget();
    if (this.cloneSyncService) {
      return { trashEntries: 0, trashBytes: 0, unknownTrashSizes: 0, invalidTrashEntries: 0, keepRefs: 0 };
    }
    const [{ entries, invalid }, keepRefs] = await Promise.all([this.trashService.listEntries(), this.listKeepRefs()]);
    return {
      trashEntries: entries.length,
      trashBytes: entries.reduce((total, entry) => total + (entry.manifest.sizeBytes ?? 0), 0),
      unknownTrashSizes: entries.filter((entry) => entry.manifest.sizeBytes === null).length,
      invalidTrashEntries: invalid.length,
      keepRefs: keepRefs.length,
    };
  }

  async forceClean(): Promise<ForceCleanResult> {
    await this.requireForceCleanTarget();
    const result = await this.runExclusiveRepoOperation(
      async () => {
        const reap = this.cloneSyncService
          ? { deleted: 0, orphanedRefsDeleted: 0, errors: [] }
          : await this.trashReaper.purgeAllUnlocked();
        const errors = [...reap.errors];
        const keepRefs = this.cloneSyncService ? [] : await this.listKeepRefs();
        // A `.diverged/<name>` directory and `keep/<name>` are the two halves of
        // one preserved worktree — the files, and the commits they were made on.
        // Dropping the ref and then running `gc --prune=now` would leave the
        // directory intact but its own recovery instructions dead, so refs whose
        // directory is still there are retained and reported instead.
        const reservedNames = this.cloneSyncService ? new Set<string>() : await this.getDivergedDirectoryNames();
        let keepRefsDeleted = 0;
        let keepRefsRetained = 0;

        for (const ref of keepRefs) {
          if (reservedNames.has(ref.slice(GIT_CONSTANTS.KEEP_REF_PREFIX.length))) {
            keepRefsRetained++;
            continue;
          }
          try {
            await this.removalAudit.record({ action: "keep_ref_delete", result: "attempt", path: ref });
            await this.gitService.deleteRef(ref);
            keepRefsDeleted++;
            await this.removalAudit.record({ action: "keep_ref_delete", result: "success", path: ref });
          } catch (error) {
            const message = getErrorMessage(error);
            errors.push(`${ref}: ${message}`);
            await this.removalAudit
              .record({ action: "keep_ref_delete", result: "failure", path: ref, error: message })
              .catch(() => undefined);
          }
        }

        const gcSucceeded = await this.maintenanceService.runNowUnlocked();
        if (!gcSucceeded) errors.push("git gc --prune=now failed");
        const after = await this.getForceCleanPreview();
        return {
          ...after,
          // The reaper's own count, not a before/after difference: a re-scan
          // cannot tell a deletion from an entry that failed and stayed put.
          trashDeleted: reap.deleted,
          keepRefsDeleted,
          keepRefsRetained,
          gcSucceeded,
          errors,
        };
      },
      { wait: true },
    );
    if (!result.started) throw new Error("Cannot force clean while another process holds the repository lock");
    return result.value;
  }

  // Entry names under `.diverged/`, which are exactly the keep-ref names the
  // non-trash diverge flow mints. Any name counts, files and symlinks included
  // (same reasoning as the reaper's pin sweep): retaining a ref costs disk,
  // dropping one can cost commits. An unreadable directory means the same —
  // refuse to delete rather than guess.
  private async getDivergedDirectoryNames(): Promise<Set<string>> {
    const divergedRoot = path.join(this.config.worktreeDir, GIT_CONSTANTS.DIVERGED_DIR_NAME);
    try {
      return new Set((await fs.readdir(divergedRoot)) ?? []);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      throw new Error(
        `cannot scan '${divergedRoot}' to protect preserved commits; refusing to delete recovery refs: ${getErrorMessage(error)}`,
      );
    }
  }

  private async requireForceCleanTarget(): Promise<void> {
    const target = this.cloneSyncService
      ? path.join(this.config.worktreeDir, PATH_CONSTANTS.GIT_DIR)
      : path.join(this.gitService.getBareRepoPath(), "HEAD");
    try {
      await fs.access(target);
    } catch {
      throw new Error(`Repository storage is unavailable at '${target}'; refusing force clean`);
    }
  }

  async deleteKeepRef(name: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`Invalid keep ref name '${name}'`);
    const ref = `${GIT_CONSTANTS.KEEP_REF_PREFIX}${name}`;
    const result = await this.runExclusiveRepoOperation(
      async () => {
        await this.removalAudit.record({ action: "keep_ref_delete", result: "attempt", path: ref });
        await this.gitService.deleteRef(ref);
        await this.removalAudit.record({ action: "keep_ref_delete", result: "success", path: ref });
      },
      { wait: true },
    );
    if (!result.started) throw new Error("Cannot delete keep ref while another process holds the lock");
  }

  async discardDivergedDirectory(targetPath: string, keepRef?: string): Promise<void> {
    const divergedRoot = path.resolve(this.config.worktreeDir, GIT_CONSTANTS.DIVERGED_DIR_NAME);
    const resolvedTarget = path.resolve(targetPath);
    if (path.dirname(resolvedTarget) !== divergedRoot) {
      throw new Error(`Refusing to discard path outside '${divergedRoot}'`);
    }
    const expectedKeepRef = `${GIT_CONSTANTS.KEEP_REF_PREFIX}${path.basename(resolvedTarget)}`;
    if (keepRef && keepRef !== expectedKeepRef) {
      throw new Error(`Refusing to delete invalid diverged keep ref '${keepRef}'`);
    }
    const result = await this.runExclusiveRepoOperation(
      async () => {
        await this.removalAudit.record({ action: "diverged_discard", result: "attempt", path: resolvedTarget });
        try {
          await fs.rm(resolvedTarget, { recursive: true, force: true });
          if (keepRef) await this.gitService.deleteRef(keepRef);
          await this.removalAudit.record({ action: "diverged_discard", result: "success", path: resolvedTarget });
        } catch (error) {
          await this.removalAudit
            .record({
              action: "diverged_discard",
              result: "failure",
              path: resolvedTarget,
              error: getErrorMessage(error),
            })
            .catch(() => undefined);
          throw error;
        }
      },
      { wait: true },
    );
    if (!result.started) throw new Error("Cannot discard diverged directory while another process holds the lock");
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
      // Cleared here — once the sync actually starts — rather than by callers:
      // a losing concurrent caller clearing the shared accumulator would
      // silently truncate the winner's skips payload.
      this.clearRecordedSkips();
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

        // Trash maintenance runs even when the sync failed: it only acts on
        // local expiry state, and a persistently failing fetch must not let
        // .trash/ grow without bound. gc stays success-only below.
        await this.runTrashMaintenanceUnlocked();
      }

      await this.runMaintenanceIfDueUnlocked();

      return this.lastOutcome ?? outcome.toOutcome(durationMs);
    });

    return result.started ? { started: true, outcome: result.value } : result;
  }
}
