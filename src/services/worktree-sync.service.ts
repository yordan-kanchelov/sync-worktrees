import * as fs from "fs/promises";
import * as path from "path";

import pLimit from "p-limit";

import { GIT_CONSTANTS, PATH_CONSTANTS } from "../constants";
import { ConfigError, TrashError, TrashOperationError } from "../errors";
import { withGitAuthHint } from "../utils/git-auth-error";
import { formatGitBusySignals, probeInFlightGitOperations } from "../utils/git-busy-probe";
import { getErrorMessage } from "../utils/lfs-error";
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
import { SyncRetryPolicy } from "./sync-retry-policy";
import { TrashMigrationService } from "./trash-migration.service";
import { TrashReaperService } from "./trash-reaper.service";
import { TrashService } from "./trash.service";
import { WorktreeModeSyncRunner } from "./worktree-mode-sync-runner";

import type { ProgressEvent, ProgressListener } from "./progress-emitter";
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

// Why an operation did not start, for callers that turn that into an error.
// Only `lock_unavailable` names a cause; the other two are contention.
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

  // Clone mode's answer to GitService.createBranch + pushBranch, which have no
  // bare repository to run in here. The TUI's branch wizard calls this and then
  // checkoutBranch(branchName, { allowConfigDrift: true }) to switch to it.
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
      // Every consumer (run-once, cron, the TUI, the MCP server) reports the
      // rejection's message, so a credential / ssh failure gets its remedy
      // hint attached here, once, on the way out.
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

  // Restore must hold the repo lock: the reaper, prune, and gc all mutate the
  // same trash entries and refs at the tail of a sync. wait:true queues behind
  // an in-flight sync instead of failing fast — restores are explicit user
  // actions, not periodic work.
  //
  // `lockWaitMs` is the same argument carried across the process boundary. The
  // in-process mutex has always queued here, but the cross-process lock did
  // not, so a restore run while a daemon was mid-sync failed immediately for a
  // reason that resolves itself in a minute. Callers that can afford to wait
  // pass a bounded budget; the default stays fail-fast.
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

  // Deletes ONE named trash entry ahead of its expiry, through the reap path
  // rather than around it. Two properties matter and both come from reusing
  // TrashReaperService.purgeEntryUnlocked instead of unlinking the container
  // here:
  //
  //  - A `keepPinOnReap` entry gets its permanent `refs/sync-worktrees/keep/<id>`
  //    ref minted BEFORE anything is deleted, and the whole purge is abandoned
  //    if that fails. Those entries exist because their commits were on no
  //    remote when the worktree was pruned, so the payload and the pin can be
  //    the only copy in existence; deleting them without the anchor destroys
  //    work. The result names any ref it minted so the caller can print it.
  //  - The payload is renamed aside before it is removed and the attempt is in
  //    the audit log before either, exactly as an expiry reap would be.
  //
  // The entry is looked up inside the lock, so "no trash entry with id" is
  // decided against the same listing the purge acts on rather than against one
  // read before the wait.
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

  // The confirmation this feeds is the only screen that shows trash bytes, and
  // this method runs outside the repo mutex — the TUI awaits it, spinner up,
  // before it draws anything — so it is where an unmeasured payload gets its
  // `du`. That keeps the scan off the lock without making the number lazier
  // than the person reading it: an entry trashed seconds ago is measured on
  // the first open, not shown as "unknown" until some later one.
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

  // `selection` is what the confirmation actually showed: the entry ids and ref
  // names behind the counts, not the counts themselves. The preview runs
  // outside the repo mutex and this runs inside it, an unbounded human pause
  // later, so a sync in between can (and does) add trash entries and keep refs.
  // Purging "everything present now" would destroy those without ever naming
  // them — some hold the only copy of never-pushed commits, and the `gc` at
  // the end makes that final. Anything not in the selection is left in place
  // and reported.
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
        // A `.diverged/<name>` directory and `keep/<name>` are the two halves of
        // one preserved worktree — the files, and the commits they were made on.
        // Dropping the ref and then running the gc would leave the
        // directory intact but its own recovery instructions dead, so refs whose
        // directory is still there are retained and reported instead.
        const reservedNames = this.cloneSyncService ? new Set<string>() : await this.getDivergedDirectoryNames();
        let keepRefsDeleted = 0;
        let keepRefsRetained = 0;
        let skippedNewKeepRefs = 0;

        for (const ref of keepRefs) {
          // Intersecting the live listing with the selection also covers the
          // other direction: a selected ref that is gone by now never shows up
          // here, so nothing is attempted for it.
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

        // The purge above only deletes directories and refs, which git itself
        // serializes. The gc rewrites the object store every checkout shares,
        // so it is the one step a person's own `git commit` in a worktree can
        // collide with. Look for commands in flight and operations left
        // half-finished, and skip the gc rather than run it into them.
        //
        // This is point-in-time, not exclusion: nothing stops a commit starting
        // the instant after the probe returns clean, and the repository lock
        // does not cover other people's git processes. It buys refusal on the
        // states that last — a conflicted merge, an interactive rebase, a held
        // `index.lock` — not a guarantee. The objects the deleted refs were
        // holding stay until the next maintenance run, which is the cheap half
        // of the trade: the trash directories are already gone.
        const busy = await probeInFlightGitOperations(this.getObjectStoreGitDir());
        const gcSkipped = busy.length > 0;
        let gcSucceeded = false;
        if (gcSkipped) {
          // The word "skipped" is load-bearing: this string is rendered next to
          // a `GC skipped` row, and calling it a failure there would recreate
          // the failed/skipped confusion this whole path exists to remove.
          errors.push(`git gc skipped, git is busy in: ${formatGitBusySignals(busy)}`);
          this.logger.warn(`🧹 Skipping force-clean gc: ${formatGitBusySignals(busy)}`);
        } else {
          gcSucceeded = await this.maintenanceService.runNowUnlocked();
          if (!gcSucceeded) errors.push("git gc failed");
        }
        // The survivors' ids are dropped: a result names counts, never a set to
        // act on — see ForceCleanResult. Unlike the preview this recount runs
        // inside the exclusive operation, so it must not measure: it reports
        // what the survivors' manifests already say.
        const { trashEntryIds: _ids, keepRefNames: _refs, ...after } = await this.buildForceCleanPreview(false);
        return {
          ...after,
          // The reaper's own count, not a before/after difference: a re-scan
          // cannot tell a deletion from an entry that failed and stayed put.
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

  // Does a `.diverged/` directory still depend on this keep ref?
  //
  // Current entries name the ref after the directory, so a direct hit settles
  // it. Entries written before this ref layout used
  // `diverged-<timestamp>-<sanitized branch>` and recorded nothing in their
  // metadata, so the only link left is the sanitized branch name that both the
  // ref and the directory carry. Matching on that keeps an upgrade from
  // purging the commits behind a copy still sitting on disk; the cost of a
  // false positive is a retained ref, the cost of a miss is the commits.
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

  // The git dir whose object store force clean's gc rewrites: the clone's own
  // in clone mode, the bare repository every worktree is linked to otherwise.
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

  // Drops many keep refs behind one confirmation, which is the only practical
  // way out from under a repository that has accumulated hundreds: the
  // single-ref path costs a typed confirmation each, and force clean is the
  // only batch alternative but also takes the whole trash and runs a gc.
  //
  // `names` is what the confirmation actually listed, not "every ref present
  // now" — same reasoning as forceClean. The listing is taken outside the repo
  // mutex and this runs inside it, a human pause later, so a sync in between
  // can mint keep refs for entries it has just reaped. Those hold commits
  // nobody has been shown, and are left in place.
  //
  // Per-ref best effort, deliberately not one `update-ref --stdin` batch: that
  // is a single transaction, so one ref another git process has locked aborts
  // every other deletion in the call (measured on git 2.43.0 — a stray `.lock`
  // left all ten refs of a ten-ref batch in place). Turning "999 dropped, 1
  // locked" into "0 dropped" is the wrong trade for a command a person runs to
  // clear a backlog.
  async deleteKeepRefs(names: readonly string[]): Promise<KeepRefDropResult> {
    for (const name of names) this.assertKeepRefName(name);
    const selected = new Set(names.map((name) => `${GIT_CONSTANTS.KEEP_REF_PREFIX}${name}`));
    const result = await this.runExclusiveRepoOperation<KeepRefDropResult>(
      async () => {
        const dropped: KeepRefDropResult = { deleted: 0, retained: [], errors: [] };
        // Intersecting the live listing with the selection covers both
        // directions: a ref minted since the listing is never in `selected`, and
        // a selected ref already gone never shows up here.
        const present = (await this.listKeepRefs()).filter((ref) => selected.has(ref));
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
      },
      { wait: true },
    );
    // TrashError, not a bare Error: the CLI reports "the daemon holds the lock"
    // as one line and exit code 1, and tells the two apart by type.
    if (!result.started)
      throw new TrashError(`Cannot delete keep refs: ${describeNotStarted(result)}`, "KEEP_REF_DROP");
    return result.value;
  }

  // A keep ref name reaches `refs/sync-worktrees/keep/<name>` as a path
  // segment, so anything that could climb out of the namespace or read as an
  // option is refused before it gets near git.
  private assertKeepRefName(name: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`Invalid keep ref name '${name}'`);
  }

  async deleteKeepRef(name: string): Promise<void> {
    this.assertKeepRefName(name);
    const ref = `${GIT_CONSTANTS.KEEP_REF_PREFIX}${name}`;
    const result = await this.runExclusiveRepoOperation(
      async () => {
        await this.removalAudit.record({ action: "keep_ref_delete", result: "attempt", path: ref });
        await this.gitService.deleteRef(ref);
        await this.removalAudit.record({ action: "keep_ref_delete", result: "success", path: ref });
      },
      { wait: true },
    );
    if (!result.started) throw new TrashError(`Cannot delete keep ref: ${describeNotStarted(result)}`, "KEEP_REF_DROP");
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

  // Runs git gc when due, inside the already-held repo lock (mirrors
  // initializeUnlocked — must NOT re-acquire runExclusiveRepoOperation or it
  // would self-deadlock/skip). Skipped under the unit-test shortcut so unit
  // suites don't shell out to real git; GitMaintenanceService is covered by
  // its own tests.
  private async runMaintenanceIfDueUnlocked(): Promise<void> {
    if (isUnitTestShortcutEnabled()) {
      return;
    }
    await this.maintenanceService.runIfDueUnlocked();
  }

  // Same contract as runMaintenanceIfDueUnlocked: tail of a successful sync,
  // inside the held lock, never fails the sync. Runs before gc so freshly
  // reaped pin refs can be collected in the same maintenance window.
  private async runTrashMaintenanceUnlocked(): Promise<void> {
    if (isUnitTestShortcutEnabled()) {
      return;
    }
    if (this.cloneSyncService) {
      return;
    }
    try {
      await this.trashMigration.migrateLegacyUnlocked();
      // The reaper releases a permanent recovery ref only on evidence that the
      // commits sit on a remote, and that evidence is only as current as the
      // remote-tracking refs. This runs in the sync's `finally`, failed attempts
      // included, so the runner — not the caller — says whether this attempt's
      // pruning fetch actually completed.
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
      const lock = await this.repoOperationLock.acquire({ waitMs: options.lockWaitMs });
      if (!lock.acquired) {
        if (lock.reason === "locked") {
          this.logger.warn("⚠️  Another process holds the sync lock for this repo, skipping...");
          return { started: false, reason: "locked" };
        }
        // Not contention: the lock could not be prepared or taken at all, so
        // the operation did not run. That is a failure of this run with a
        // cause worth naming, never a skip that blames another process.
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

  // Interactive variant: queues behind any in-flight sync/op instead of failing fast.
  async runQueuedRepoOperation<T>(operation: () => Promise<T>): Promise<ExclusiveRepoOperationResult<T>> {
    return this.runExclusiveRepoOperation(operation, { wait: true });
  }

  private emitProgress(event: ProgressEvent): void {
    this.progressEmitter.emit(event);
  }

  async sync(): Promise<SyncResult> {
    // Set as the first statement inside the exclusive operation so the `finally`
    // below can tell "the operation ran" from "it never started". The result
    // object cannot answer that on the failure path: a sync that trashes a
    // worktree and then throws on a later phase rejects out of here without
    // ever producing one, and those entries would stay unmeasured until some
    // later tick happened to succeed.
    let operationRan = false;
    try {
      const result = await this.runExclusiveRepoOperation<SyncOutcome>(async () => {
        operationRan = true;
        // Cleared here — once the sync actually starts — rather than by callers:
        // a losing concurrent caller clearing the shared accumulator would
        // silently truncate the winner's skips payload.
        this.clearRecordedSkips();
        // A pendingInitSkip minted by an earlier standalone initialize() must
        // not leak into this operation: its skip record was just wiped above,
        // and consuming the stale token would suppress the re-detection in
        // runSyncAttempt — the sync would then report clean with zero actions.
        // The in-operation init below re-arms the token when it still applies.
        this.clearPendingInitSkip();
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
          let clonedThisOperation = false;
          if (!this.isInitialized()) {
            await this.initializeUnlocked(outcome);
            // `outcome` was constructed a few lines up and nothing else has
            // written to it, so a `created` action in it can only be the clone
            // this init just made — not an adopted existing clone, which records
            // nothing, and not a worktree-mode init, which is handed no
            // accumulator at all. That clone came from `origin` at the tracked
            // branch, so the sync attempt below would fetch a ref it already has
            // and scan a working tree git checked out moments ago. The check is
            // deliberately scoped to an init that ran *inside this operation*:
            // a standalone `initialize()` (the run-once CLI, the TUI, the MCP
            // `initialize` tool) can be followed by a sync at any distance, and
            // a flag carried across that boundary cannot tell a sync a second
            // later from one an hour later — a sync that silently does nothing
            // is a worse defect than the tick this saves. What that leaves on
            // the table is small: since CloneSyncService classifies before it
            // reads the working tree, a post-clone tick ends `up_to_date`
            // without a status scan, so what those callers still pay for is one
            // no-op fetch.
            clonedThisOperation = this.cloneSyncService !== undefined && outcome.getCounts().created > 0;
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
            if (clonedThisOperation) {
              this.logger.info(
                "Clone was created by this run; it is at the tracked remote tip, so no fetch is needed.",
              );
            } else {
              // Same timer the worktree-mode runner is given, so `debug` prints
              // one table in one format whichever mode the repository is in.
              await retry(() => cloneSync.runSyncAttempt(outcome, phaseTimer), retryOptionsWithOutcomeReset);
            }
          } else {
            await retry(
              () => this.worktreeModeSyncRunner.runSyncAttempt(phaseTimer, syncContext, outcome),
              retryOptionsWithOutcomeReset,
            );
          }
        } catch (rawError) {
          // A credential / ssh failure carries its remedy hint from here on:
          // the outcome, this log line and the rejection every consumer reports.
          const error = withGitAuthHint(rawError);
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
    } finally {
      // Past the closing brace above the repo lock is released and the mutex
      // slot is free, which is the whole reason this line is here and not in
      // the trash maintenance inside. Sizing trash payloads execs `du` over
      // entire worktrees; it is informational (TrashService.listEntriesWithSizes)
      // and it is the one piece of trash bookkeeping slow enough that running
      // it under the lock would make every MCP call fail fast and every TUI
      // action queue for its duration. In a `finally` because a sync that
      // trashes a worktree and then throws on a later phase has left behind
      // exactly the unmeasured entries this exists to measure. Still awaited,
      // not detached: it finishes inside the sync it belongs to, before the
      // next tick or the reaper can run — and it never throws, so it cannot
      // mask the sync failure it is unwinding through.
      if (operationRan) await this.measureTrashSizesOffLock();
    }
  }

  // NOT one of the *Unlocked helpers — those run inside a held lock, this one
  // must run outside it. Failures are logged and dropped: a size nobody has
  // yet is not a reason to fail a sync that has already finished, and the next
  // tick (or the force-clean preview) measures the entry instead.
  //
  // What that leaves is one tick of lag in the reaper's warnSizeBytes warning,
  // which is raised inside the lock a few lines earlier: entries trashed by
  // this tick are still unmeasured when it computes its total, so they count
  // from the next tick on. The warning is an advisory about days of
  // accumulation, and the lag only ever under-states it — it cannot raise a
  // false alarm.
  private async measureTrashSizesOffLock(): Promise<void> {
    if (this.cloneSyncService) return;
    try {
      await this.trashService.listEntriesWithSizes();
    } catch (error) {
      this.logger.debug(`Trash size accounting failed: ${getErrorMessage(error)}`);
    }
  }
}
