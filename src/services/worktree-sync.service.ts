import * as fs from "fs/promises";
import * as path from "path";

import pLimit from "p-limit";

import { GIT_CONSTANTS, PATH_CONSTANTS } from "../constants";
import { ConfigError, TrashError, TrashOperationError } from "../errors";
import { probePathExists } from "../utils/file-exists";
import { withGitAuthHint } from "../utils/git-auth-error";
import { formatGitBusySignals, probeInFlightGitOperations } from "../utils/git-busy-probe";
import { redactRepoUrl } from "../utils/git-url";
import { getErrorMessage } from "../utils/errors";
import { getRemovalAuditLogPath } from "../utils/lock-path";
import { formatRepoLockUnavailable } from "../utils/repo-lock-format";
import { REPOSITORY_MODES, resolveMode } from "../utils/repo-mode";
import { retry } from "../utils/retry";
import { PhaseTimer, Timer, formatTimingTable } from "../utils/timing";
import { isUnitTestShortcutEnabled } from "../utils/unit-test-shortcut";

import { type CloneSkipReason, CloneSyncService } from "./clone-sync.service";
import { GitMaintenanceService } from "./git-maintenance.service";
import { GitService } from "./git.service";
import { Logger } from "./logger.service";
import { ProgressEmitter } from "./progress-emitter";
import { RemovalAuditService } from "./removal-audit.service";
import { RepoOperationLock } from "./repo-operation-lock";
import { SyncOutcomeAccumulator } from "./sync-outcome";
import { SyncDryRunPlanBuilder } from "./sync-plan";
import { SyncRetryPolicy } from "./sync-retry-policy";
import { TrashMigrationService } from "./trash-migration.service";
import { TrashReaperService } from "./trash-reaper.service";
import { TrashService } from "./trash.service";
import { WorktreeModeSyncRunner } from "./worktree-mode-sync-runner";

import type { RegisteredWorktree } from "./git.service";
import type { ProgressEvent, ProgressListener } from "./progress-emitter";
import type { SyncPlanResult } from "./sync-plan";
import type { TrashEntry, TrashManifest } from "./trash.service";
import type {
  Config,
  ForceCleanPreview,
  ForceCleanResult,
  ForceCleanSelection,
  KeepRefDropResult,
  RepoOperationNotStarted,
  SyncOutcome,
  SyncResult,
  TrashPurgeResult,
} from "../types";
import type { LfsErrorContext } from "../utils/retry";

export type { ProgressEvent, ProgressListener } from "./progress-emitter";
export type {
  RepoLockUnavailable,
  RepoOperationNotStarted,
  SyncOutcome,
  SyncOutcomeAction,
  SyncOutcomeCounts,
  SyncResult,
} from "../types";

export type ExclusiveRepoOperationResult<T> = { started: true; value: T } | RepoOperationNotStarted;

function describeNotStarted(result: RepoOperationNotStarted): string {
  switch (result.reason) {
    case "in_progress":
      return "another repository operation is in progress";
    case "locked":
      return "another process holds the repository lock";
    case "lock_unavailable":
      return formatRepoLockUnavailable(result);
  }
}

export class WorktreeSyncService {
  private gitService: GitService;
  private cloneSyncService: CloneSyncService | null = null;
  private logger: Logger;
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
      const cloneSync = this.cloneSyncService;
      this.maintenanceService.setTargetGuard(() => cloneSync.assertPrimaryCheckout());
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

  async getWorktrees(options: { includeDetached?: boolean } = {}): Promise<RegisteredWorktree[]> {
    if (this.cloneSyncService) {
      return this.cloneSyncService.getWorktrees();
    }
    return this.gitService.getWorktrees(options);
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

  async createAndPushBranch(baseBranch: string, branchName: string): Promise<void> {
    if (!this.cloneSyncService) {
      throw new ConfigError("createAndPushBranch is only available for clone-mode repositories", "CLONE_MODE_REQUIRED");
    }
    await this.cloneSyncService.createAndPushBranch(baseBranch, branchName);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized()) return;
    const result = await this.runExclusiveRepoOperation(() => this.initializeUnlocked());
    if (!result.started) {
      if (result.reason === "lock_unavailable") {
        this.logger.error(`❌ Initialize not run: ${formatRepoLockUnavailable(result)}`);
        return;
      }
      const reason = result.reason === "in_progress" ? "operation in progress" : "another process holds the lock";
      this.logger.warn(`⚠️  Initialize skipped: ${reason}`);
    }
  }

  async initializeUnlocked(outcome?: SyncOutcomeAccumulator): Promise<void> {
    this.emitProgress({ phase: "initialize", message: "Initializing repository" });
    try {
      if (this.cloneSyncService) {
        await this.cloneSyncService.initialize(outcome);
      } else {
        await this.gitService.initialize();
      }
    } catch (error) {
      throw withGitAuthHint(error);
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

  async restoreFromTrash(id: string, options: { lockWaitMs?: number } = {}): Promise<TrashManifest> {
    const result = await this.runExclusiveRepoOperation(() => this.trashService.restore(id), {
      wait: true,
      lockWaitMs: options.lockWaitMs,
    });
    if (!result.started) {
      throw new TrashOperationError("restore", `cannot restore trash entry '${id}': ${describeNotStarted(result)}`);
    }
    return result.value;
  }

  async purgeTrashEntry(id: string, options: { lockWaitMs?: number } = {}): Promise<TrashPurgeResult> {
    if (this.cloneSyncService) {
      throw new TrashOperationError("purge", "trash operations are only available for worktree-mode repositories");
    }
    const result = await this.runExclusiveRepoOperation<TrashPurgeResult>(
      async () => {
        const { entries } = await this.trashService.listEntries();
        if (!entries.some((candidate) => candidate.manifest.id === id)) {
          throw new TrashOperationError("purge", `no trash entry with id '${id}'`);
        }
        const reap = await this.trashReaper.purgeEntryUnlocked(id);
        return { deleted: reap.deleted > 0, keepRefsMinted: reap.keepRefsMinted, errors: reap.errors };
      },
      { wait: true, lockWaitMs: options.lockWaitMs },
    );
    if (!result.started) {
      throw new TrashOperationError("purge", `cannot purge trash entry '${id}': ${describeNotStarted(result)}`);
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
    return this.buildForceCleanPreview(true);
  }

  private async buildForceCleanPreview(measureSizes: boolean): Promise<ForceCleanPreview> {
    await this.requireForceCleanTarget();
    if (this.cloneSyncService) {
      return {
        trashEntries: 0,
        trashBytes: 0,
        unknownTrashSizes: 0,
        invalidTrashEntries: 0,
        keepRefs: 0,
        trashEntryIds: [],
        keepRefNames: [],
      };
    }
    const [{ entries, invalid }, keepRefs] = await Promise.all([
      measureSizes ? this.trashService.listEntriesWithSizes() : this.trashService.listEntries(),
      this.listKeepRefs(),
    ]);
    return {
      trashEntries: entries.length,
      trashBytes: entries.reduce((total, entry) => total + (entry.manifest.sizeBytes ?? 0), 0),
      unknownTrashSizes: entries.filter((entry) => entry.manifest.sizeBytes === null).length,
      invalidTrashEntries: invalid.length,
      keepRefs: keepRefs.length,
      trashEntryIds: entries.map((entry) => entry.manifest.id),
      keepRefNames: [...keepRefs],
    };
  }

  async forceClean(selection: ForceCleanSelection): Promise<ForceCleanResult> {
    await this.requireForceCleanTarget();
    const selectedKeepRefs = new Set(selection.keepRefNames);
    const result = await this.runExclusiveRepoOperation(
      async () => {
        const reap = this.cloneSyncService
          ? { deleted: 0, orphanedRefsDeleted: 0, skippedNotSelected: 0, keepRefsMinted: [], errors: [] }
          : await this.trashReaper.purgeAllUnlocked(selection.trashEntryIds);
        const errors = [...reap.errors];
        const keepRefs = this.cloneSyncService ? [] : await this.listKeepRefs();
        const reservedNames = this.cloneSyncService ? new Set<string>() : await this.getDivergedDirectoryNames();
        let keepRefsDeleted = 0;
        let keepRefsRetained = 0;
        let skippedNewKeepRefs = 0;

        for (const ref of keepRefs) {
          if (!selectedKeepRefs.has(ref)) {
            skippedNewKeepRefs++;
            continue;
          }
          if (this.isKeepRefReserved(ref.slice(GIT_CONSTANTS.KEEP_REF_PREFIX.length), reservedNames)) {
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

        const busy = await probeInFlightGitOperations(this.getObjectStoreGitDir());
        const gcSkipped = busy.length > 0;
        let gcSucceeded = false;
        if (gcSkipped) {
          errors.push(`git gc skipped, git is busy in: ${formatGitBusySignals(busy)}`);
          this.logger.warn(`🧹 Skipping force-clean gc: ${formatGitBusySignals(busy)}`);
        } else {
          gcSucceeded = await this.maintenanceService.runNowUnlocked();
          if (!gcSucceeded) errors.push("git gc failed");
        }
        const { trashEntryIds: _ids, keepRefNames: _refs, ...after } = await this.buildForceCleanPreview(false);
        return {
          ...after,
          trashDeleted: reap.deleted,
          keepRefsDeleted,
          keepRefsRetained,
          skippedNewEntries: reap.skippedNotSelected,
          skippedNewKeepRefs,
          gcSucceeded,
          gcSkipped,
          errors,
        };
      },
      { wait: true },
    );
    if (!result.started) throw new Error(`Cannot force clean: ${describeNotStarted(result)}`);
    return result.value;
  }

  private isKeepRefReserved(refName: string, divergedNames: Set<string>): boolean {
    if (divergedNames.has(refName)) return true;

    const legacy = /^diverged-[^-]+-(.+)$/.exec(refName);
    if (!legacy) return false;
    const branchSegment = legacy[1];
    for (const divergedName of divergedNames) {
      if (divergedName.includes(branchSegment)) return true;
    }
    return false;
  }

  private async getDivergedDirectoryNames(): Promise<Set<string>> {
    const divergedRoot = path.join(this.config.worktreeDir, GIT_CONSTANTS.DIVERGED_DIR_NAME);
    try {
      return new Set(await fs.readdir(divergedRoot));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      throw new Error(
        `cannot scan '${divergedRoot}' to protect preserved commits; refusing to delete recovery refs: ${getErrorMessage(error)}`,
      );
    }
  }

  private getObjectStoreGitDir(): string {
    return this.cloneSyncService
      ? path.join(this.config.worktreeDir, PATH_CONSTANTS.GIT_DIR)
      : this.gitService.getBareRepoPath();
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

  async deleteKeepRefs(names: readonly string[]): Promise<KeepRefDropResult> {
    for (const name of names) this.assertKeepRefName(name);
    const selected = new Set(names.map((name) => `${GIT_CONSTANTS.KEEP_REF_PREFIX}${name}`));
    const result = await this.runExclusiveRepoOperation<KeepRefDropResult>(
      async () => {
        const { missing: _missing, ...dropped } = await this.dropKeepRefsUnlocked(selected);
        return dropped;
      },
      { wait: true },
    );
    if (!result.started)
      throw new TrashError(`Cannot delete keep refs: ${describeNotStarted(result)}`, "KEEP_REF_DROP");
    return result.value;
  }

  private assertKeepRefName(name: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`Invalid keep ref name '${name}'`);
  }

  private async dropKeepRefsUnlocked(selected: Set<string>): Promise<KeepRefDropResult & { missing: string[] }> {
    const dropped: KeepRefDropResult & { missing: string[] } = { deleted: 0, retained: [], errors: [], missing: [] };
    const listed = new Set(await this.listKeepRefs());
    const present = [...selected].filter((ref) => listed.has(ref));
    dropped.missing = [...selected].filter((ref) => !listed.has(ref));
    const reservedNames = await this.getDivergedDirectoryNames();
    for (const ref of present) {
      if (this.isKeepRefReserved(ref.slice(GIT_CONSTANTS.KEEP_REF_PREFIX.length), reservedNames)) {
        dropped.retained.push(ref);
        continue;
      }
      try {
        await this.removalAudit.record({ action: "keep_ref_delete", result: "attempt", path: ref });
        await this.gitService.deleteRef(ref);
        dropped.deleted++;
        await this.removalAudit.record({ action: "keep_ref_delete", result: "success", path: ref });
      } catch (error) {
        const message = getErrorMessage(error);
        dropped.errors.push(`${ref}: ${message}`);
        await this.removalAudit
          .record({ action: "keep_ref_delete", result: "failure", path: ref, error: message })
          .catch(() => undefined);
      }
    }
    return dropped;
  }

  async deleteKeepRef(name: string): Promise<void> {
    this.assertKeepRefName(name);
    const ref = `${GIT_CONSTANTS.KEEP_REF_PREFIX}${name}`;
    const result = await this.runExclusiveRepoOperation(() => this.dropKeepRefsUnlocked(new Set([ref])), {
      wait: true,
    });
    if (!result.started) throw new TrashError(`Cannot delete keep ref: ${describeNotStarted(result)}`, "KEEP_REF_DROP");
    const dropped = result.value;
    if (dropped.missing.length > 0) throw new TrashError(`No keep ref named '${name}'`, "KEEP_REF_DROP");
    if (dropped.retained.length > 0) {
      throw new TrashError(
        `Keep ref '${name}' retained: a '.diverged/' directory still depends on it`,
        "KEEP_REF_DROP",
      );
    }
    if (dropped.errors.length > 0) {
      throw new TrashError(`Could not delete keep ref '${name}': ${dropped.errors.join("; ")}`, "KEEP_REF_DROP");
    }
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
    if (!result.started) throw new Error(`Cannot discard diverged directory: ${describeNotStarted(result)}`);
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

  private async runMaintenanceIfDueUnlocked(): Promise<void> {
    if (isUnitTestShortcutEnabled()) {
      return;
    }
    await this.maintenanceService.runIfDueUnlocked();
  }

  private async runTrashMaintenanceUnlocked(): Promise<void> {
    if (isUnitTestShortcutEnabled()) {
      return;
    }
    if (this.cloneSyncService) {
      return;
    }
    try {
      await this.trashMigration.migrateLegacyUnlocked();
      await this.trashReaper.reapExpiredUnlocked(new Date(), {
        remoteRefsFresh: this.worktreeModeSyncRunner.didPruneAllRemoteRefs(),
      });
    } catch (error) {
      this.logger.warn(`⚠️ Trash maintenance failed: ${getErrorMessage(error)}`);
    }
  }

  onProgress(listener: ProgressListener): () => void {
    return this.progressEmitter.onProgress(listener);
  }

  async runExclusiveRepoOperation<T>(
    operation: () => Promise<T>,
    options: { wait?: boolean; lockWaitMs?: number } = {},
  ): Promise<ExclusiveRepoOperationResult<T>> {
    if (!options.wait && this.repoMutex.activeCount + this.repoMutex.pendingCount > 0) {
      this.logger.warn("⚠️  Another repository operation is already in progress, skipping...");
      return { started: false, reason: "in_progress" };
    }

    return this.repoMutex(async (): Promise<ExclusiveRepoOperationResult<T>> => {
      const lock = await this.repoOperationLock.acquire({ waitMs: options.lockWaitMs });
      if (!lock.acquired) {
        if (lock.reason === "locked") {
          this.logger.warn("⚠️  Another process holds the sync lock for this repo, skipping...");
          return { started: false, reason: "locked" };
        }
        this.logger.error(`❌ Operation not run: ${formatRepoLockUnavailable(lock)}`);
        return { started: false, reason: "lock_unavailable", path: lock.path, code: lock.code, error: lock.error };
      }

      try {
        return { started: true, value: await operation() };
      } finally {
        try {
          await lock.release();
        } catch (releaseError) {
          this.logger.warn(`Failed to release sync lock: ${getErrorMessage(releaseError)}`);
        }
      }
    });
  }

  async runQueuedRepoOperation<T>(operation: () => Promise<T>): Promise<ExclusiveRepoOperationResult<T>> {
    return this.runExclusiveRepoOperation(operation, { wait: true });
  }

  private emitProgress(event: ProgressEvent): void {
    this.progressEmitter.emit(event);
  }

  async sync(options: { signal?: AbortSignal } = {}): Promise<SyncResult> {
    let operationRan = false;
    try {
      const result = await this.runExclusiveRepoOperation<SyncOutcome>(async () => {
        operationRan = true;
        this.clearRecordedSkips();
        this.clearPendingInitSkip();
        const totalTimer = new Timer();
        const phaseTimer = new PhaseTimer();
        const outcome = new SyncOutcomeAccumulator({
          mode: this.cloneSyncService ? "clone" : "worktree",
          repoName: (this.config as { name?: string }).name,
        });
        const syncContext = this.retryPolicy.createContext();
        const retryOptions = { ...this.retryPolicy.createOptions(syncContext), signal: options.signal };
        let durationMs: number | undefined;
        let syncStarted = false;

        try {
          let clonedThisOperation = false;
          if (!this.isInitialized()) {
            const initBaseline = outcome.snapshot();
            await retry(() => this.initializeUnlocked(outcome), {
              ...retryOptions,
              onRetry: (error: unknown, attempt: number, context?: LfsErrorContext): void => {
                outcome.restore(initBaseline);
                retryOptions.onRetry?.(error, attempt, context);
              },
            });
            clonedThisOperation = this.cloneSyncService !== null && outcome.getCounts().created > 0;
          }

          this.logger.info(`[${new Date().toISOString()}] Starting worktree synchronization...`);
          syncStarted = true;

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
            if (clonedThisOperation) {
              this.logger.info(
                "Clone was created by this run; it is at the tracked remote tip, so no fetch is needed.",
              );
            } else {
              await retry(() => cloneSync.runSyncAttempt(outcome, phaseTimer), retryOptionsWithOutcomeReset);
            }
          } else {
            await retry(
              () => this.worktreeModeSyncRunner.runSyncAttempt(phaseTimer, syncContext, outcome),
              retryOptionsWithOutcomeReset,
            );
          }
        } catch (rawError) {
          const error = withGitAuthHint(rawError);
          if (!outcome.hasFailureOutside("sparse-checkout")) {
            outcome.recordFailed("repo", getErrorMessage(error), { reason: "sync_failed" });
          }
          this.logger.error("\n❌ Error during worktree synchronization after all retry attempts:", error);
          throw error;
        } finally {
          this.retryPolicy.resetLfsSkipIfNeeded(syncContext);
          if (syncStarted) this.logger.info(`[${new Date().toISOString()}] Synchronization finished.\n`);
          durationMs = totalTimer.stop();
          this.lastOutcome = outcome.toOutcome(durationMs);

          if (this.config.debug) {
            const phaseResults = phaseTimer.getResults();
            const repoName = (this.config as { name?: string }).name;
            this.logger.table(formatTimingTable(durationMs, phaseResults, repoName));
          }

          await this.runTrashMaintenanceUnlocked();
        }

        await this.runMaintenanceIfDueUnlocked();

        return this.lastOutcome ?? outcome.toOutcome(durationMs);
      });

      return result.started ? { started: true, outcome: result.value } : result;
    } finally {
      if (operationRan) await this.measureTrashSizesOffLock();
    }
  }

  async planSync(): Promise<SyncPlanResult> {
    const mode = this.cloneSyncService ? "clone" : "worktree";
    const repoName = (this.config as { name?: string }).name;
    const plan = new SyncDryRunPlanBuilder({ mode, ...(repoName !== undefined && { repoName }) });
    const gitService = new GitService(this.config, this.logger, undefined, { readOnly: true });

    if (this.cloneSyncService) {
      const cloneSync = new CloneSyncService(this.config, gitService, this.logger, { readOnly: true });
      if ((await probePathExists(path.join(this.config.worktreeDir, PATH_CONSTANTS.GIT_DIR))) === "missing") {
        await cloneSync.planSyncAttempt(plan);
        return { started: true, plan: plan.build() };
      }
      const result = await this.runExclusiveRepoOperation(() => cloneSync.planSyncAttempt(plan));
      return result.started ? { started: true, plan: plan.build() } : result;
    }

    const planOnDisk = async (): Promise<boolean> => {
      const opened = await gitService.openForPlanning();
      if (opened.state === "missing") return false;
      plan.markFetched();
      const runner = new WorktreeModeSyncRunner(this.config, gitService, this.logger, new ProgressEmitter(), {
        trashService: new TrashService(this.config, gitService, this.logger, this.removalAudit),
        removalAudit: this.removalAudit,
      });
      await runner.planSyncAttempt(plan);
      return true;
    };

    if ((await probePathExists(path.join(gitService.getBareRepoPath(), "HEAD"))) === "missing") {
      this.planInitialClone(plan, gitService.getBareRepoPath());
      return { started: true, plan: plan.build() };
    }
    const result = await this.runExclusiveRepoOperation(planOnDisk);
    if (!result.started) return result;
    if (!result.value) this.planInitialClone(plan, gitService.getBareRepoPath());
    return { started: true, plan: plan.build() };
  }

  private planInitialClone(plan: SyncDryRunPlanBuilder, bareRepoPath: string): void {
    plan.add({
      kind: "clone",
      path: path.resolve(bareRepoPath),
      message: `clone ${redactRepoUrl(this.config.repoUrl)} as a bare repository, then create a worktree for every branch that passes the filters`,
    });
    plan.note("The repository has not been cloned yet, so the branches it would get worktrees for are not listed.");
  }

  private async measureTrashSizesOffLock(): Promise<void> {
    if (this.cloneSyncService) return;
    try {
      await this.trashService.listEntriesWithSizes();
    } catch (error) {
      this.logger.debug(`Trash size accounting failed: ${getErrorMessage(error)}`);
    }
  }
}
