import * as fs from "fs/promises";
import * as path from "path";

import pLimit from "p-limit";

import { DEFAULT_CONFIG, ERROR_MESSAGES, GIT_CONSTANTS, METADATA_CONSTANTS } from "../constants";
import { TrashOperationError, WorktreeNotCleanError } from "../errors";
import { filterBranchesByName } from "../utils/branch-filter";
import { filterBranchesByAge, formatDuration } from "../utils/date-filter";
import { probePathExists } from "../utils/file-exists";
import { getErrorMessage, isLfsError } from "../utils/lfs-error";
import { getRemovalAuditLogPath } from "../utils/lock-path";

import { PathResolutionService } from "./path-resolution.service";
import { RemovalAuditService } from "./removal-audit.service";
import { TrashService } from "./trash.service";
import { createWorktreeSyncPlan } from "./worktree-sync-planner";

import type { AddWorktreeResult, AheadBehindCounts, GitService } from "./git.service";
import type { Logger } from "./logger.service";
import type { ProgressEmitter } from "./progress-emitter";
import type { SyncOutcomeAccumulator } from "./sync-outcome";
import type { SyncRetryContext } from "./sync-retry-policy";
import type { TrashEntry } from "./trash.service";
import type { WorktreeStatusDetails, WorktreeStatusResult } from "./worktree-status.service";
import type { CreateAction, PruneAction, SparseAction, SyncPlan, UpdateAction } from "./worktree-sync-planner";
import type { Config } from "../types";
import type { PhaseTimer } from "../utils/timing";

// How many worktreeDir containment probes may be in flight at once. Pure stat
// work, so this is about event-loop latency rather than about a process budget.
const PATH_CONTAINMENT_CONCURRENCY = 8;

export class WorktreeModeSyncRunner {
  private pathResolution = new PathResolutionService();
  private removalAudit: RemovalAuditService;
  private trashService: TrashService;

  constructor(
    private config: Config,
    private gitService: GitService,
    private logger: Logger,
    private progressEmitter: ProgressEmitter,
    services?: { trashService: TrashService; removalAudit: RemovalAuditService },
  ) {
    this.removalAudit = services?.removalAudit ?? new RemovalAuditService(getRemovalAuditLogPath(config));
    this.trashService = services?.trashService ?? new TrashService(config, gitService, logger, this.removalAudit);
  }

  updateLogger(logger: Logger): void {
    this.logger = logger;
    this.trashService.updateLogger(logger);
  }

  async runSyncAttempt(
    phaseTimer: PhaseTimer,
    syncContext: SyncRetryContext,
    outcome: SyncOutcomeAccumulator,
  ): Promise<void> {
    await this.ensureFetchAnchor(outcome);
    await this.fetchLatestRemoteData(phaseTimer, syncContext);

    const { remoteBranches, defaultBranch } = await this.resolveSyncBranches(outcome);
    const pendingDivergedBranches = await this.getPendingDivergedBranches();

    await fs.mkdir(this.config.worktreeDir, { recursive: true });

    const registeredWorktrees = await this.gitService.getWorktrees();
    const { worktrees, externalWorktrees } = await this.partitionByWorktreeDir(registeredWorktrees);
    const externalBranches = new Set(externalWorktrees.map((worktree) => worktree.branch));
    const plannedBranches = remoteBranches.filter(
      (branch) => !externalBranches.has(branch) && !pendingDivergedBranches.has(branch),
    );
    await this.dropStaleRegistrations(worktrees, new Set(plannedBranches));
    this.logger.info(`Found ${worktrees.length} managed Git worktrees.`);
    for (const worktree of externalWorktrees) {
      this.logger.warn(`  - Skipping external worktree outside worktreeDir: ${worktree.path}`);
    }

    const syncPlan = createWorktreeSyncPlan(
      {
        remoteBranches: plannedBranches,
        defaultBranch,
        existingWorktrees: worktrees,
        worktreeDir: this.config.worktreeDir,
      },
      {
        pathResolution: this.pathResolution,
        updateExistingWorktrees: this.config.updateExistingWorktrees !== false,
        sparseCheckout: this.config.sparseCheckout,
      },
    );

    await this.createNewWorktreesWithTiming(syncPlan, phaseTimer, syncContext, outcome);
    // One listing of origin's tips for the whole attempt: the tip recording
    // below and the update phase's "nothing changed" test read the same map.
    // Nothing fetches between them, so no second look could say anything new.
    const remoteTips = await this.readRemoteBranchTips();
    await this.recordRemoteBranchTips(
      [...worktrees, ...syncPlan.create.filter((action) => action.kind === "create")],
      remoteTips,
    );
    await this.pruneOldWorktreesWithTiming(syncPlan.prune, phaseTimer, outcome);

    if (this.config.updateExistingWorktrees !== false) {
      await this.updateExistingWorktreesWithTiming(syncPlan.update, phaseTimer, syncContext, outcome, remoteTips);
    }

    if (this.config.sparseCheckout) {
      await this.reapplySparseCheckout(syncPlan.sparse, outcome);
    }

    await this.finalizeSyncAttempt(phaseTimer);
  }

  private async reapplySparseCheckout(actions: SparseAction[], outcome: SyncOutcomeAccumulator): Promise<void> {
    const sparseConfig = this.config.sparseCheckout;
    if (!sparseConfig) return;

    this.logger.info("Step 5: Reconciling sparse-checkout patterns on existing worktrees...");
    const sparseService = this.gitService.getSparseCheckoutService();
    const desired = sparseService.buildPatterns(sparseConfig);

    const limit = pLimit(this.config.parallelism?.maxStatusChecks ?? DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS);

    await Promise.all(
      actions.map((action) =>
        limit(async () => {
          if (action.kind !== "check-sparse") return;

          try {
            try {
              await fs.access(action.path);
            } catch {
              return;
            }

            const current = await sparseService.readCurrent(action.path);
            if (current !== null && sparseService.patternsEqual(current, desired)) return;

            if (sparseService.isNarrowing(current, desired)) {
              const status = await this.gitService.getFullWorktreeStatus(action.path, false);
              if (!status.canRemove) {
                this.logger.warn(
                  `  - Skipping sparse-checkout narrowing for '${action.branch}': ${status.reasons.join(", ")}.`,
                );
                outcome.recordSkipped("sparse-checkout", "sparse_narrowing_unsafe", {
                  branch: action.branch,
                  path: action.path,
                  message: status.reasons.join(", "),
                });
                return;
              }
            }

            await sparseService.applyToWorktree(action.path, sparseConfig);
            await this.gitService.checkoutHead(action.path);
            this.logger.info(`  - ✅ Sparse-checkout updated for '${action.branch}'`);
            outcome.recordUpdated(action.branch, action.path, "sparse_checkout");
          } catch (error) {
            this.logger.warn(
              `  - ⚠️ Failed to update sparse-checkout for '${action.branch}': ${getErrorMessage(error)}`,
            );
            outcome.recordFailed("sparse-checkout", getErrorMessage(error), {
              reason: "sparse_checkout_failed",
              branch: action.branch,
              path: action.path,
            });
          }
        }),
      ),
    );
  }

  // Splits the registered worktrees into the ones inside worktreeDir and the
  // ones a user registered elsewhere, which the sync leaves alone.
  //
  // worktreeDir is canonicalized once for the whole partition rather than
  // re-resolved alongside every candidate: this runs on every sync attempt in
  // the TUI/daemon process, where a few hundred synchronous realpath walks are
  // milliseconds of blocked event loop — a dropped frame and a late cron
  // callback — and are multiplied by every repository sharing the process.
  // Every candidate is still canonicalized individually, so a worktree that
  // reaches outside the base through a symlink is still classified as external.
  // The one snapshot of the base makes the batch consistent rather than safer:
  // swapping worktreeDir mid-partition can no longer have some candidates
  // judged against the old directory and the rest against the new one, but a
  // base already swapped when the snapshot is taken now applies to the whole
  // batch instead of a prefix of it. Either way that needs write control over
  // worktreeDir's parent, which is already control of the tree being managed.
  private async partitionByWorktreeDir<T extends { path: string }>(
    registeredWorktrees: T[],
  ): Promise<{ worktrees: T[]; externalWorktrees: T[] }> {
    if (registeredWorktrees.length === 0) {
      return { worktrees: [], externalWorktrees: [] };
    }
    const resolvedWorktreeDir = await this.pathResolution.resolveBaseDir(this.config.worktreeDir);
    // Bounded rather than one probe per worktree at once: a few hundred
    // in-flight probes queue behind libuv's thread pool and land their
    // callbacks in a single poll phase, which stalls the loop for longer than
    // the synchronous version being replaced ever did.
    const limit = pLimit(PATH_CONTAINMENT_CONCURRENCY);
    const inside = await Promise.all(
      registeredWorktrees.map((worktree) =>
        limit(() => this.pathResolution.isPathInsideResolvedBaseDir(worktree.path, resolvedWorktreeDir)),
      ),
    );

    const worktrees: T[] = [];
    const externalWorktrees: T[] = [];
    for (const [index, worktree] of registeredWorktrees.entries()) {
      if (inside[index]) {
        worktrees.push(worktree);
      } else {
        externalWorktrees.push(worktree);
      }
    }
    return { worktrees, externalWorktrees };
  }

  // A registration whose directory is definitively gone (rm -rf, a wiped volume)
  // still makes the planner believe the branch is checked out: no create action,
  // and an update action against a path that no longer exists, so the worktree is
  // never rebuilt. Dropping it from the inventory turns it back into a create.
  //
  // Deliberately only bookkeeping — nothing is removed here. `addWorktree`'s
  // "already registered worktree" recovery clears the registration, and it asks
  // git whether the entry is still prunable first, so a directory that came back
  // between this probe and that moment is left alone instead of force-removed.
  //
  // Two narrowings: only branches the plan still wants (a branch gone upstream
  // stays with the prune pipeline, which owns removals and their audit records),
  // and only a definitive "missing" (an unverifiable path keeps its registration
  // so no second worktree is ever built over one that still exists).
  private async dropStaleRegistrations(
    worktrees: { path: string; branch: string }[],
    plannedBranches: Set<string>,
  ): Promise<void> {
    const stale: { path: string; branch: string }[] = [];
    for (const worktree of worktrees) {
      if (plannedBranches.has(worktree.branch) && (await probePathExists(worktree.path)) === "missing") {
        stale.push(worktree);
      }
    }

    for (const worktree of stale) {
      this.logger.info(
        `  - Registration for '${worktree.branch}' points at a missing directory (${worktree.path}); rebuilding it.`,
      );
      worktrees.splice(worktrees.indexOf(worktree), 1);
    }
  }

  // A diverged replace whose replacement worktree was never created leaves the
  // trashed payload as the only copy of that branch's work. Reserving the branch
  // keeps sync from taking `originalPath` before the user can `trash --restore`.
  //
  // Three deliberate narrowings, each of which was a way to strand a branch:
  //  - `replacedAt` set means the replacement exists, so the reserve is spent.
  //    Without this, any later removal of the replacement (branch deleted then
  //    re-pushed, worktree removed by hand) re-arms the reservation and the
  //    branch stops syncing until the entry expires.
  //  - only a definitive "missing" reserves; an unverifiable probe lets the
  //    branch keep syncing, because a silently unsynced branch is worse than a
  //    restore that fails with a clear message.
  //  - `.diverged/` copies never reserve: nothing restores from them, and those
  //    directories are never cleaned up, so the block would be permanent.
  private async getPendingDivergedBranches(): Promise<Set<string>> {
    const pending = new Set<string>();
    // With trash off the reaper leaves existing entries alone, so nothing would
    // ever release the reserve. An expiring reservation is a delay; one that
    // cannot expire is a branch that stops syncing for good.
    if (!this.trashService.isEnabled()) return pending;

    // Deliberately unguarded: `listEntries` already returns an empty list for an
    // absent trash root, so anything thrown here means the root exists and could
    // not be read. Swallowing that reads as "nothing reserved" and lets sync take
    // a path a payload is still waiting on, so the sync fails loudly instead.
    const { entries } = await this.trashService.listEntries();
    for (const { manifest } of entries) {
      if (
        manifest.reason === "diverged-replace" &&
        manifest.branch &&
        !manifest.replacedAt &&
        (await probePathExists(manifest.originalPath)) === "missing"
      ) {
        pending.add(manifest.branch);
        this.logger.info(
          `  - Reserving '${manifest.originalPath}' for trash entry '${manifest.id}'; '${manifest.branch}' stays unsynced until it is restored or expires (${manifest.expiresAt}).`,
        );
      }
    }

    return pending;
  }

  // The fetch below and every remote-facing read after it run with the default
  // branch's worktree as their working directory, and the planner never plans a
  // create for the default branch. So a directory deleted out-of-band (rm -rf,
  // an unmounted volume) has to be rebuilt here, before the first git command:
  // GitService.initialize heals it too, but a long-lived process only
  // initializes once and every later sync would otherwise fail at the fetch.
  private async ensureFetchAnchor(outcome: SyncOutcomeAccumulator): Promise<void> {
    if (!(await this.gitService.ensureAnchorWorktree())) return;

    const branch = this.gitService.getDefaultBranch();
    const anchorPath = this.gitService.getMainWorktreePath();
    this.logger.info(`  ✅ Recreated the '${branch}' worktree at '${anchorPath}'`);
    outcome.recordCreated(branch, anchorPath);
  }

  private async fetchLatestRemoteData(phaseTimer: PhaseTimer, syncContext: SyncRetryContext): Promise<void> {
    this.logger.info("Step 1: Fetching latest data from remote...");
    phaseTimer.startPhase("Phase 1: Fetch");
    this.progressEmitter.emit({ phase: "fetch", message: "Fetching latest data from remote" });

    try {
      await this.gitService.fetchAll();
    } catch (fetchError) {
      const errorMessage = getErrorMessage(fetchError);

      if (isLfsError(errorMessage) && !syncContext.lfsSkipEnabled && !this.config.skipLfs) {
        this.logger.info("⚠️  Fetch all failed due to LFS error. Attempting branch-by-branch fetch...");
        this.logger.info("⚠️  Temporarily disabling LFS downloads for branch-by-branch fetch...");
        this.gitService.setLfsSkipEnabled(true);
        syncContext.lfsSkipEnabled = true;
        await this.fetchBranchByBranch();
      } else {
        throw fetchError;
      }
    } finally {
      phaseTimer.endPhase();
    }
  }

  private async resolveSyncBranches(
    outcome: SyncOutcomeAccumulator,
  ): Promise<{ remoteBranches: string[]; defaultBranch: string }> {
    const { all, filtered: remoteBranches } = this.config.branchMaxAge
      ? await this.getRemoteBranchesFilteredByActivity()
      : await this.getRemoteBranchesFilteredByName();
    const defaultBranch = await this.resolveDefaultBranch(all, outcome);

    // The default branch stays in the inventory even when the name or age
    // filters drop it: its worktree is where every fetch runs. Only while
    // origin still has it, though. A default the remote renamed or deleted
    // has no origin/<branch> to update from, so retaining it would leave a
    // permanent update candidate that fails every sync and a worktree that is
    // never pruned; it goes through the normal prune pipeline instead.
    if (!all.includes(defaultBranch)) {
      this.logger.warn(`Default branch '${defaultBranch}' does not exist on origin; not retaining its worktree.`);
    } else if (!remoteBranches.includes(defaultBranch)) {
      remoteBranches.push(defaultBranch);
      this.logger.info(`Ensuring default branch '${defaultBranch}' is retained.`);
    }

    return { remoteBranches, defaultBranch };
  }

  // A default branch absent from the freshly fetched refs means the remote
  // renamed or deleted it (fetch --prune never updates origin/HEAD, so the
  // detected name would otherwise stay frozen). GitService re-resolves it and
  // moves the fetch anchor first — the new default's worktree is created or
  // adopted and fetches run from it from now on — so the old default's
  // worktree can be pruned further down without breaking the next fetch. It
  // throws when no default that exists on origin can be resolved, which fails
  // this sync before anything is pruned while the old worktree still anchors
  // the fetch.
  private async resolveDefaultBranch(remoteBranches: string[], outcome: SyncOutcomeAccumulator): Promise<string> {
    const current = this.gitService.getDefaultBranch();
    if (remoteBranches.includes(current)) return current;

    this.logger.info(`Default branch '${current}' no longer exists on origin; re-resolving the default branch...`);
    const refresh = await this.gitService.refreshDefaultBranch();
    if (refresh.created) {
      this.logger.info(`  ✅ Created worktree for '${refresh.defaultBranch}' at '${refresh.mainWorktreePath}'`);
      outcome.recordCreated(refresh.defaultBranch, refresh.mainWorktreePath);
    }
    return refresh.defaultBranch;
  }

  // Both listings resolve to every remote branch (`all`) and the ones that
  // pass the configured filters (`filtered`).
  private async getRemoteBranchesFilteredByActivity(): Promise<{ all: string[]; filtered: string[] }> {
    const branchesWithActivity = await this.gitService.getRemoteBranchesWithActivity();
    this.logger.info(`Found ${branchesWithActivity.length} remote branches.`);

    const branchNames = filterBranchesByName(
      branchesWithActivity.map((b) => b.branch),
      this.config.branchInclude,
      this.config.branchExclude,
    );

    if (branchNames.length < branchesWithActivity.length) {
      this.logger.info(
        `After branch name filtering: ${branchNames.length} of ${branchesWithActivity.length} branches.`,
      );
    }

    const branchNameSet = new Set(branchNames);
    const filteredByName = branchesWithActivity.filter((b) => branchNameSet.has(b.branch));
    const filteredBranches = filterBranchesByAge(filteredByName, this.config.branchMaxAge!);
    const remoteBranches = filteredBranches.map((b) => b.branch);

    this.logger.info(
      `After filtering by age (${formatDuration(this.config.branchMaxAge!)}): ${remoteBranches.length} branches.`,
    );

    if (filteredByName.length > remoteBranches.length) {
      const excludedCount = filteredByName.length - remoteBranches.length;
      this.logger.info(`  - Excluded ${excludedCount} stale branches.`);
    }

    return { all: branchesWithActivity.map((b) => b.branch), filtered: remoteBranches };
  }

  private async getRemoteBranchesFilteredByName(): Promise<{ all: string[]; filtered: string[] }> {
    const allBranches = await this.gitService.getRemoteBranches();
    this.logger.info(`Found ${allBranches.length} remote branches.`);

    const remoteBranches = filterBranchesByName(allBranches, this.config.branchInclude, this.config.branchExclude);

    if (remoteBranches.length < allBranches.length) {
      this.logger.info(`After branch name filtering: ${remoteBranches.length} of ${allBranches.length} branches.`);
    }

    return { all: allBranches, filtered: remoteBranches };
  }

  private async finalizeSyncAttempt(phaseTimer: PhaseTimer): Promise<void> {
    phaseTimer.startPhase("Phase 5: Cleanup");
    this.progressEmitter.emit({ phase: "cleanup", message: "Cleanup complete" });
    phaseTimer.endPhase();
  }

  private async createNewWorktreesWithTiming(
    syncPlan: SyncPlan,
    phaseTimer: PhaseTimer,
    syncContext: SyncRetryContext,
    outcome: SyncOutcomeAccumulator,
  ): Promise<void> {
    phaseTimer.startPhase("Phase 2: Create");
    this.progressEmitter.emit({ phase: "create", message: "Creating worktrees for new branches" });

    await this.createNewWorktrees(syncPlan.create, syncContext, outcome);

    phaseTimer.setPhaseCount("Phase 2: Create", syncPlan.create.length);
    phaseTimer.endPhase();
  }

  private async createNewWorktrees(
    actions: CreateAction[],
    syncContext: SyncRetryContext,
    outcome: SyncOutcomeAccumulator,
  ): Promise<void> {
    if (actions.length === 0) {
      this.logger.info("Step 2: No new branches to create worktrees for.");
      return;
    }

    const plan: Array<{ branchName: string; worktreePath: string }> = [];
    for (const action of actions) {
      if (action.kind === "skip-create") {
        this.logger.error(
          `  ❌ Skipping '${action.branch}': sanitized worktree path '${action.path}' collides with existing branch '${action.conflictingBranch}'.`,
        );
        outcome.recordSkipped("branch", "path_collision", {
          branch: action.branch,
          path: action.path,
          message: `Path collides with existing branch '${action.conflictingBranch}'`,
        });
        continue;
      }

      plan.push({ branchName: action.branch, worktreePath: action.path });
    }

    this.logger.info(`Step 2: Creating ${plan.length} new worktrees...`);

    // Worktree creation has concurrency=1 by default because Git's worktree.lock
    // can cause race conditions when multiple operations run simultaneously.
    // If concurrent operations try to create the same worktree, we gracefully handle
    // the "already registered" error by checking if the worktree actually exists.
    const maxConcurrent =
      this.config.parallelism?.maxWorktreeCreation ?? DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_CREATION;
    const limit = pLimit(maxConcurrent);

    const results = await Promise.allSettled(
      plan.map(({ branchName, worktreePath }) =>
        limit(async () => {
          let addResult: AddWorktreeResult;
          try {
            addResult = await this.addWorktreeWithLfsFallback(branchName, worktreePath, syncContext, outcome);
          } catch (error) {
            this.logger.error(`  ❌ Failed to create worktree for '${branchName}':`, getErrorMessage(error));
            outcome.recordFailed("worktree", getErrorMessage(error), {
              reason: "create_failed",
              branch: branchName,
              path: worktreePath,
            });
            throw error;
          }

          // A detached registration already sits at the target path: someone
          // checked a commit out inside the worktree by hand, which drops it
          // from the inventory the plan was built from and makes its branch
          // look new every tick. Nothing was created, so report the skip
          // rather than counting a creation that never happened.
          if (addResult.status === "already_registered" && addResult.detached) {
            const message = `Worktree at '${worktreePath}' is on a detached HEAD, so sync leaves it alone; check the branch back out to have it synced again`;
            this.logger.warn(`  ⏭️ Skipping '${branchName}': ${message}`);
            outcome.recordSkipped("worktree", "detached_worktree", {
              branch: branchName,
              path: worktreePath,
              message,
            });
            return false;
          }

          // Either this call created the worktree, or a concurrent creator
          // registered the same branch at the same path first; both leave the
          // worktree this sync asked for in place.
          this.logger.info(`  ✅ Created worktree for '${branchName}'`);
          outcome.recordCreated(branchName, worktreePath);
          if (addResult.status === "created") {
            await this.verifyCreatedWorktreeTip(branchName, worktreePath, addResult.head, outcome);
          }
          return true;
        }),
      ),
    );

    const successCount = results.filter((r) => r.status === "fulfilled" && r.value).length;
    this.logger.info(`  Created ${successCount}/${plan.length} worktrees successfully`);
  }

  // `git fetch` into a bare repository never runs the LFS smudge filter, so the
  // fallback in fetchLatestRemoteData is not where LFS actually fails — the
  // checkout inside `git worktree add` is (an object missing on the server, an
  // endpoint the daemon holds no credentials for). That failure was recorded as
  // create_failed and then dropped by the create phase's allSettled, so it never
  // reached retry()'s LFS handler: the branch failed again on every tick while
  // GIT_LFS_SKIP_SMUDGE=1 would have checked its pointer files out.
  //
  // So the fallback happens here, per branch and bounded to one extra attempt.
  // Whether the skip was already on is read before the attempt: a checkout that
  // already ran with LFS downloads off has nothing left to fall back to, and its
  // failure is recorded by the caller exactly as before.
  private async addWorktreeWithLfsFallback(
    branchName: string,
    worktreePath: string,
    syncContext: SyncRetryContext,
    outcome: SyncOutcomeAccumulator,
  ): Promise<AddWorktreeResult> {
    const skipAlreadyEnabled = this.config.skipLfs === true || syncContext.lfsSkipEnabled;

    try {
      return await this.gitService.addWorktree(branchName, worktreePath);
    } catch (error) {
      if (skipAlreadyEnabled || !isLfsError(getErrorMessage(error))) throw error;

      this.logger.warn(`  - ⚠️ LFS checkout failed for '${branchName}': ${getErrorMessage(error)}`);
      this.enableLfsSkipForSync(syncContext, outcome, branchName, worktreePath);
      return await this.gitService.addWorktree(branchName, worktreePath);
    }
  }

  // The skip is a GitService-wide switch (every client it hands out then carries
  // GIT_LFS_SKIP_SMUDGE=1), restored by resetLfsSkipIfNeeded when the sync ends,
  // so it is flipped once per sync rather than once per branch: the create phase
  // checks several branches out at a time and each of them can fail this way.
  // No lock is needed — nothing awaits between the read and the writes below, so
  // the first branch through flips it and the others just retry under it.
  private enableLfsSkipForSync(
    syncContext: SyncRetryContext,
    outcome: SyncOutcomeAccumulator,
    branch: string,
    worktreePath: string,
  ): void {
    if (syncContext.lfsSkipEnabled) return;

    this.logger.info("⚠️  Temporarily disabling LFS downloads for this sync...");
    this.gitService.setLfsSkipEnabled(true);
    syncContext.lfsSkipEnabled = true;
    outcome.recordNoop("repo", "lfs_skip_enabled", {
      branch,
      path: worktreePath,
      message: "LFS downloads disabled for the rest of this sync after an LFS checkout failure",
    });
  }

  // addWorktree starts a new worktree at origin/<branch> unless the bare
  // repository's local ref for the branch carries commits origin/<branch>
  // does not reach, in which case it keeps that tip. The update phase was
  // planned before the create, so nothing else looks at the new worktree
  // until the next sync: report the mismatch now rather than a plain
  // "created" for a worktree whose files are not the remote's. Never fails
  // the sync — the worktree exists and the next sync's update rules own it.
  private async verifyCreatedWorktreeTip(
    branch: string,
    worktreePath: string,
    createdHead: string,
    outcome: SyncOutcomeAccumulator,
  ): Promise<void> {
    let remoteTip: string;
    try {
      remoteTip = await this.gitService.getRemoteCommit(`${GIT_CONSTANTS.REFS.REMOTES}/${branch}`);
    } catch (error) {
      this.logger.warn(
        `  - ⚠️ Could not verify that the new worktree for '${branch}' starts at origin/${branch}: ${getErrorMessage(error)}`,
      );
      return;
    }
    if (remoteTip === createdHead) return;

    const message = `Worktree starts at ${createdHead.slice(0, 7)} while origin/${branch} is at ${remoteTip.slice(0, 7)}: it was not moved to origin/${branch} (local-only commits, or the fast-forward was skipped; see the log); the next sync applies its usual update rules`;
    this.logger.warn(`  - ⚠️ '${branch}': ${message}`);
    outcome.recordSkipped("worktree", "local_only_commits", { branch, path: worktreePath, message });
  }

  // Persist each worktree's upstream tip while the remote ref still exists.
  // This is the proof consulted after a squash-merge deletes the branch:
  // "HEAD was on the remote before the deletion" — without it every such
  // worktree reads as having unpushed commits forever. Best-effort: a failed
  // recording only means that worktree stays conservatively preserved.
  private async recordRemoteBranchTips(
    worktrees: Array<{ path: string; branch: string }>,
    tips: Map<string, string> | null,
  ): Promise<void> {
    if (tips === null || tips.size === 0) return;

    const limit = pLimit(this.config.parallelism?.maxStatusChecks ?? DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS);

    await Promise.all(
      worktrees.map((wt) =>
        limit(async () => {
          const oid = tips.get(wt.branch);
          if (!oid) return;
          await this.gitService
            .recordRemoteTip(wt.path, wt.branch, oid)
            .catch((error: unknown) =>
              this.logger.warn(`  - ⚠️ Could not record remote tip for '${wt.branch}': ${getErrorMessage(error)}`),
            );
        }),
      ),
    );
  }

  // Every origin tip in one `for-each-ref` on the bare repo. Best effort on
  // purpose: both readers have a per-worktree fallback, so a listing that
  // failed costs speed and a metadata record, never a sync — the update phase
  // simply probes every worktree the way it did before this listing existed.
  private async readRemoteBranchTips(): Promise<Map<string, string> | null> {
    try {
      return await this.gitService.getRemoteBranchTips();
    } catch (error) {
      this.logger.warn(`⚠️ Could not read remote branch tips: ${getErrorMessage(error)}`);
      return null;
    }
  }

  // A removal authorized only by the fully-pushed proof must stay reversible:
  // without trash it would be a permanent delete of commits whose remote
  // branch may have been deleted unmerged.
  private blockedByDisabledTrash(status: WorktreeStatusResult): boolean {
    return status.fullyPushedUpstreamDeleted && !this.trashService.isEnabled();
  }

  private async pruneOldWorktreesWithTiming(
    actions: PruneAction[],
    phaseTimer: PhaseTimer,
    outcome: SyncOutcomeAccumulator,
  ): Promise<void> {
    phaseTimer.startPhase("Phase 3: Prune");
    this.progressEmitter.emit({ phase: "prune", message: "Pruning stale worktrees" });

    await this.pruneOldWorktrees(actions, outcome);

    phaseTimer.setPhaseCount("Phase 3: Prune", actions.length);
    phaseTimer.endPhase();
  }

  private async pruneOldWorktrees(actions: PruneAction[], outcome: SyncOutcomeAccumulator): Promise<void> {
    // A locked worktree never reaches the status probe, the `du` scan or a
    // rename: git refuses to remove it while the lock stands, so touching it
    // would only burn work on every tick and end in that refusal.
    const checks: Array<{ branch: string; path: string }> = [];
    for (const action of actions) {
      if (action.kind === "skip-prune") {
        const because = action.lockReason !== undefined ? `: ${action.lockReason}` : "";
        this.logger.info(
          `  - 🔒 Skipping removal of '${action.branch}' - the worktree is locked${because}. To let sync remove it: git worktree unlock ${action.path}`,
        );
        outcome.recordSkipped("worktree", "worktree_locked", {
          branch: action.branch,
          path: action.path,
          message: `worktree is locked${because}`,
        });
        continue;
      }
      checks.push({ branch: action.branch, path: action.path });
    }

    if (checks.length > 0) {
      this.logger.info(`Step 3: Checking ${checks.length} stale worktrees to prune...`);

      // Two-phase approach: First check status in parallel (read-only, safe),
      // then remove worktrees in parallel (mutation, needs lower concurrency).
      // This limit bounds the checks in flight; the git processes they fan out
      // to are bounded by the status service's own budget of the same size, so
      // a tick that turns up hundreds of prune candidates still peaks at
      // maxStatusChecks git processes.
      const maxConcurrent = this.config.parallelism?.maxStatusChecks ?? DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS;
      const limit = pLimit(maxConcurrent);

      const statusResults = await Promise.allSettled(
        checks.map(({ path: worktreePath }) =>
          limit(async () => this.gitService.getFullWorktreeStatus(worktreePath, this.config.debug)),
        ),
      );

      const toRemove: Array<{ branchName: string; worktreePath: string }> = [];
      const toSkip: Array<{
        branchName: string;
        worktreePath: string;
        status: Awaited<ReturnType<GitService["getFullWorktreeStatus"]>>;
      }> = [];

      // allSettled keeps the input order, so checks[index] is this worktree.
      // A rejection carries the git command and its stderr but no cwd, so the
      // branch and path have to come from here or the log line and the skip
      // name none of the worktrees the daemon was checking.
      statusResults.forEach((result, index) => {
        const { branch: branchName, path: worktreePath } = checks[index];
        if (result.status === "fulfilled") {
          const status = result.value;
          if (status.canRemove) {
            if (this.blockedByDisabledTrash(status)) {
              this.logger.warn(
                `  - ⚠️ '${branchName}' was fully pushed before its remote branch was deleted, but trash is disabled — keeping worktree. Enable trash for reversible auto-removal, or remove manually.`,
              );
              outcome.recordSkipped("worktree", "fully_pushed_trash_disabled", {
                branch: branchName,
                path: worktreePath,
                message: "fully pushed before upstream deletion; trash disabled",
              });
            } else {
              toRemove.push({ branchName, worktreePath });
            }
          } else {
            toSkip.push({ branchName, worktreePath, status });
          }
        } else {
          this.logger.error(`  - Error checking worktree '${branchName}' (${worktreePath}):`, result.reason);
          this.logger.warn(`  - ⚠️ Skipping removal of '${branchName}' due to status check failure (conservative)`);
          outcome.recordSkipped("worktree", "prune_status_check_failed", {
            branch: branchName,
            path: worktreePath,
            message: getErrorMessage(result.reason),
          });
        }
      });

      if (toRemove.length > 0) {
        const removeLimit = pLimit(
          this.config.parallelism?.maxWorktreeRemoval ?? DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_REMOVAL,
        );

        const removeResults = await Promise.allSettled(
          toRemove.map(({ branchName, worktreePath }) =>
            removeLimit(async () => {
              try {
                // Re-validate status immediately before removal to close TOCTOU window.
                const recheck = await this.gitService.getFullWorktreeStatus(worktreePath, false);
                if (!recheck.canRemove || this.blockedByDisabledTrash(recheck)) {
                  this.logger.warn(
                    `  ⚠️ Skipping removal of '${branchName}' - status changed since initial check: ${recheck.reasons.join(", ")}`,
                  );
                  outcome.recordSkipped("worktree", "prune_status_changed", {
                    branch: branchName,
                    path: worktreePath,
                    message: recheck.reasons.join(", "),
                  });
                  return false;
                }
                // The audit record must exist before the data is gone; an
                // unwritable audit log blocks removal (fail-closed).
                try {
                  await this.removalAudit.record({
                    action: "prune_remove",
                    result: "attempt",
                    path: worktreePath,
                    branch: branchName,
                    status: recheck,
                  });
                } catch (auditError) {
                  this.logger.warn(
                    `  ⚠️ Skipping removal of '${branchName}' - cannot write removal audit log: ${getErrorMessage(auditError)}`,
                  );
                  outcome.recordSkipped("worktree", "audit_log_unavailable", {
                    branch: branchName,
                    path: worktreePath,
                    message: getErrorMessage(auditError),
                  });
                  return false;
                }
                // A previous removal may have moved the directory away and then
                // failed to clear the registration — re-trashing a missing path
                // would fail with ENOENT on every tick forever. There is nothing
                // left to preserve, so clear that one registration. Targeted
                // `worktree remove --force` (NOT global `worktree prune`): prune
                // would also drop unrelated unlocked registrations whose dirs sit
                // on a temporarily unavailable mount. A locked registration makes
                // single --force fail, which correctly preserves it.
                if ((await probePathExists(worktreePath)) === "missing") {
                  await this.gitService.removeWorktree(worktreePath, { force: true });
                  this.logger.info(`  ✅ Cleared dangling registration for '${branchName}' (directory already gone)`);
                  outcome.recordRemoved(branchName, worktreePath);
                  await this.removalAudit
                    .record({ action: "prune_remove", result: "success", path: worktreePath, branch: branchName })
                    .catch((auditError: unknown) =>
                      this.logger.warn(`  ⚠️ Failed to write removal audit record: ${getErrorMessage(auditError)}`),
                    );
                  return true;
                }
                let refWarning: string | undefined;
                if (this.trashService.isEnabled()) {
                  const { entry, branchRefError } = await this.trashService.trashAndUnregisterWorktree({
                    dirPath: worktreePath,
                    branch: branchName,
                    reason: "prune",
                    keepPinOnReap: recheck.fullyPushedUpstreamDeleted,
                  });
                  if (branchRefError !== undefined) {
                    refWarning = `leftover_branch_ref: could not delete branch ref '${branchName}': ${branchRefError}`;
                  }
                  const pushedNote = recheck.fullyPushedUpstreamDeleted
                    ? " — was fully pushed before its remote branch was deleted"
                    : "";
                  this.logger.info(
                    `  ✅ Moved worktree for '${branchName}' to trash (id: ${entry.manifest.id})${pushedNote}`,
                  );
                } else {
                  await this.gitService.removeWorktree(worktreePath);
                  this.logger.info(`  ✅ Removed worktree for '${branchName}'`);
                }
                outcome.recordRemoved(branchName, worktreePath, refWarning);
                await this.removalAudit
                  .record({ action: "prune_remove", result: "success", path: worktreePath, branch: branchName })
                  .catch((auditError: unknown) =>
                    this.logger.warn(`  ⚠️ Failed to write removal audit record: ${getErrorMessage(auditError)}`),
                  );
                return true;
              } catch (error) {
                if (error instanceof WorktreeNotCleanError) {
                  this.logger.warn(`  ⚠️ Skipping removal of '${branchName}' - git refused: ${getErrorMessage(error)}`);
                  outcome.recordSkipped("worktree", "git_refused_removal", {
                    branch: branchName,
                    path: worktreePath,
                    message: getErrorMessage(error),
                  });
                  return false;
                }
                if (error instanceof TrashOperationError) {
                  this.logger.warn(`  ⚠️ Skipping removal of '${branchName}' - ${getErrorMessage(error)}`);
                  outcome.recordSkipped("worktree", "trash_failed", {
                    branch: branchName,
                    path: worktreePath,
                    message: getErrorMessage(error),
                  });
                  return false;
                }
                this.logger.error(`  ❌ Failed to remove worktree for '${branchName}':`, getErrorMessage(error));
                outcome.recordFailed("worktree", getErrorMessage(error), {
                  reason: "remove_failed",
                  branch: branchName,
                  path: worktreePath,
                });
                throw error;
              }
            }),
          ),
        );

        const removedCount = removeResults.filter((r) => r.status === "fulfilled" && r.value).length;
        this.logger.info(`  Removed ${removedCount}/${toRemove.length} worktrees successfully`);
      }

      if (toSkip.length > 0) {
        this.logger.info(`  Skipped ${toSkip.length} worktree(s) with local changes or unpushed commits`);
      }

      for (const { branchName, worktreePath, status } of toSkip) {
        outcome.recordSkipped("worktree", "unsafe_to_remove", {
          branch: branchName,
          path: worktreePath,
          message: status.reasons.join(", "),
        });

        if (status.upstreamGone && status.hasUnpushedCommits) {
          this.logger.warn(`  - ⚠️ Cannot automatically remove '${branchName}' - upstream branch was deleted.`);
          this.logger.info(`     Please review manually: cd ${worktreePath} && git log`);
          this.logger.info(
            `     If changes were squash-merged, you can safely remove with: git worktree remove ${worktreePath}`,
          );
        } else {
          this.logger.info(`  - ⚠️ Skipping removal of '${branchName}' due to: ${status.reasons.join(", ")}.`);
        }

        if (this.config.debug && status.details) {
          this.logDebugDetails(branchName, status.details);
        }
      }
    } else if (actions.length === 0) {
      this.logger.info("Step 3: No stale worktrees to prune.");
    }
  }

  private logDebugDetails(branchName: string, details: WorktreeStatusDetails): void {
    this.logger.info(`\n     🔍 Debug details for '${branchName}':`);

    if (details.modifiedFiles > 0 && details.modifiedFilesList) {
      this.logger.info(`        - Modified files (${details.modifiedFiles}):`);
      details.modifiedFilesList.forEach((file) => this.logger.info(`          • ${file}`));
    }
    if (details.deletedFiles > 0 && details.deletedFilesList) {
      this.logger.info(`        - Deleted files (${details.deletedFiles}):`);
      details.deletedFilesList.forEach((file) => this.logger.info(`          • ${file}`));
    }
    if (details.renamedFiles > 0 && details.renamedFilesList) {
      this.logger.info(`        - Renamed files (${details.renamedFiles}):`);
      details.renamedFilesList.forEach((file) => this.logger.info(`          • ${file.from} → ${file.to}`));
    }
    if (details.createdFiles > 0 && details.createdFilesList) {
      this.logger.info(`        - Created files (${details.createdFiles}):`);
      details.createdFilesList.forEach((file) => this.logger.info(`          • ${file}`));
    }
    if (details.conflictedFiles > 0 && details.conflictedFilesList) {
      this.logger.info(`        - Conflicted files (${details.conflictedFiles}):`);
      details.conflictedFilesList.forEach((file) => this.logger.info(`          • ${file}`));
    }
    if (details.untrackedFiles > 0 && details.untrackedFilesList) {
      this.logger.info(`        - Untracked files (not ignored) (${details.untrackedFiles}):`);
      details.untrackedFilesList.forEach((file) => this.logger.info(`          • ${file}`));
    }
    if (details.unpushedCommitCount !== undefined && details.unpushedCommitCount > 0) {
      this.logger.info(`        - Unpushed commits: ${details.unpushedCommitCount}`);
    }
    if (details.stashCount !== undefined && details.stashCount > 0) {
      this.logger.info(`        - Stashed changes: ${details.stashCount}`);
    }
    if (details.operationType) {
      this.logger.info(`        - Operation in progress: ${details.operationType}`);
    }
    if (details.modifiedSubmodules && details.modifiedSubmodules.length > 0) {
      this.logger.info(`        - Modified submodules (${details.modifiedSubmodules.length}):`);
      details.modifiedSubmodules.forEach((submodule) => this.logger.info(`          • ${submodule}`));
    }

    this.logger.info("");
  }

  private async fetchBranchByBranch(): Promise<void> {
    this.logger.info("Fetching branches individually to isolate LFS errors...");

    const remoteBranches = await this.gitService.getRemoteBranches();
    this.logger.info(`Found ${remoteBranches.length} remote branches to fetch.`);

    const fetchLimit = pLimit(
      this.config.parallelism?.maxBranchFetches ?? DEFAULT_CONFIG.PARALLELISM.MAX_BRANCH_FETCHES,
    );
    const failedBranches: string[] = [];
    let successCount = 0;

    const results = await Promise.allSettled(
      remoteBranches.map((branch) =>
        fetchLimit(async () => {
          await this.gitService.fetchBranch(branch);
          return branch;
        }),
      ),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        successCount++;
      } else {
        const errorMessage = getErrorMessage(result.reason);
        this.logger.info(`  ⚠️  Failed to fetch branch '${remoteBranches[i]}': ${errorMessage}`);
        failedBranches.push(remoteBranches[i]);
      }
    }

    this.logger.info(`Branch-by-branch fetch completed: ${successCount}/${remoteBranches.length} successful`);

    if (failedBranches.length > 0) {
      this.logger.info(`⚠️  Failed to fetch ${failedBranches.length} branches due to errors.`);
      this.logger.info(`   These branches will be skipped: ${failedBranches.join(", ")}`);
    }
  }

  private async updateExistingWorktreesWithTiming(
    actions: UpdateAction[],
    phaseTimer: PhaseTimer,
    syncContext: SyncRetryContext,
    outcome: SyncOutcomeAccumulator,
    remoteTips: Map<string, string> | null,
  ): Promise<void> {
    phaseTimer.startPhase("Phase 4: Update");
    this.progressEmitter.emit({ phase: "update", message: "Updating existing worktrees" });

    await this.updateExistingWorktrees(actions, syncContext, outcome, remoteTips);

    phaseTimer.setPhaseCount("Phase 4: Update", actions.length);
    phaseTimer.endPhase();
  }

  private async updateExistingWorktrees(
    actions: UpdateAction[],
    syncContext: SyncRetryContext,
    outcome: SyncOutcomeAccumulator,
    remoteTips: Map<string, string> | null,
  ): Promise<void> {
    this.logger.info("Step 4: Checking for worktrees that need updates...");

    const divergedDir = path.join(this.config.worktreeDir, GIT_CONSTANTS.DIVERGED_DIR_NAME);
    try {
      const diverged = await fs.readdir(divergedDir);
      if (diverged.length > 0) {
        this.logger.info(
          `📦 Note: ${diverged.length} diverged worktree(s) in ${path.relative(process.cwd(), divergedDir)}`,
        );
      }
    } catch {
      // No diverged directory, that's fine.
    }

    type UpdateCheckResult =
      | { action: "update" | "diverged"; worktree: { path: string; branch: string } }
      | {
          action: "skip" | "noop";
          worktree: { path: string; branch: string };
          reason: string;
          message?: string;
        };

    // Phase 4a: Check which worktrees need updates (parallel, read-only, high concurrency)
    const maxConcurrent = this.config.parallelism?.maxStatusChecks ?? DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS;
    const limit = pLimit(maxConcurrent);

    const checkResults = await Promise.allSettled(
      actions.map((action) =>
        limit(async (): Promise<UpdateCheckResult> => {
          const worktree = { path: action.path, branch: action.branch };

          try {
            await fs.access(worktree.path);
          } catch {
            return { action: "skip", worktree, reason: "missing_worktree_path" };
          }

          const hasOp = await this.gitService.hasOperationInProgress(worktree.path);
          if (hasOp) return { action: "skip", worktree, reason: "operation_in_progress" };

          // The cheap answer first: git's own registration listing resolved
          // this worktree's HEAD, and one for-each-ref gave origin's tip for
          // every branch. When they are the same oid there is provably nothing
          // to fast-forward, nothing to diverge from and nothing an ahead/behind
          // probe could add — so neither `git status` nor any per-worktree git
          // process runs, which is what keeps a tick where nothing changed off
          // the repository's back. (The oid is HEAD's, not the bare repo's
          // refs/heads/<branch>: it is the worktree's own view, so a checkout
          // that moved out from under the branch ref cannot slip through here.)
          //
          // Both oids are a snapshot: HEAD comes from the listing taken at the
          // top of the attempt and the tips from after the create phase, which
          // is not instant when there are worktrees to build. A HEAD that moves
          // *to* the tip in that window still falls through to the probes, so
          // the comparison only ever errs toward doing more work — except for a
          // HEAD moved *away* from the tip (a `reset --hard` mid-attempt),
          // which still matches the stale oid and is reported up to date.
          // Nothing is mutated on that path; the next tick reads the new HEAD
          // and updates it, so the cost is one tick of latency.
          const remoteTip = remoteTips?.get(worktree.branch);
          if (remoteTip !== undefined && action.head === remoteTip) {
            return { action: "noop", worktree, reason: "already_up_to_date" };
          }

          const isClean = await this.gitService.checkWorktreeStatus(worktree.path);
          if (!isClean) return { action: "skip", worktree, reason: "dirty_worktree" };

          // One `rev-list --left-right --count` in place of the merge-base pair
          // plus the behind probe, with the same verdicts: no commits of its
          // own means a fast-forward reaches the remote tip, commits on both
          // sides (unrelated histories included, which count on both sides)
          // mean diverged, and only commits of its own mean unpushed work.
          // Same contract as those probes too — it throws rather than answering
          // when it could not run, so a spawn failure never reads as "diverged"
          // and never sends a healthy worktree into diverged handling.
          const { ahead, behind } = await this.gitService.getAheadBehindCounts(worktree.path, worktree.branch);
          if (ahead > 0) {
            if (behind > 0) return { action: "diverged", worktree };
            this.logger.info(`⏭️  Skipping '${worktree.branch}' - has unpushed commits`);
            return { action: "skip", worktree, reason: "local_ahead" };
          }
          if (behind === 0) return { action: "noop", worktree, reason: "already_up_to_date" };

          const sparseCfg = this.config.sparseCheckout;
          if (sparseCfg && sparseCfg.skipUpdateWhenOutsideSparse !== false) {
            const sparseService = this.gitService.getSparseCheckoutService();
            if (sparseService.resolveMode(sparseCfg) === "cone") {
              const diff = await this.gitService.getChangedPathsInRange(
                worktree.path,
                "HEAD",
                `origin/${worktree.branch}`,
              );
              // null = git diff failed; force update rather than treat the failure as "no sparse paths affected".
              if (diff !== null && !sparseService.pathsTouchSparse(diff, sparseCfg)) {
                this.logger.info(`⏭️  Skipping '${worktree.branch}' - upstream changes outside sparse paths`);
                return { action: "skip", worktree, reason: "outside_sparse_checkout" };
              }
            }
          }

          return { action: "update", worktree };
        }),
      ),
    );

    const worktreesToUpdate: { path: string; branch: string }[] = [];
    const divergedWorktrees: { path: string; branch: string }[] = [];

    checkResults.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value) {
        switch (result.value.action) {
          case "update":
            worktreesToUpdate.push(result.value.worktree);
            break;
          case "diverged":
            divergedWorktrees.push(result.value.worktree);
            break;
          case "noop":
            outcome.recordNoop("worktree", result.value.reason, result.value.worktree);
            break;
          case "skip":
            outcome.recordSkipped("worktree", result.value.reason, result.value.worktree);
            break;
        }
      } else if (result.status === "rejected") {
        // Probe-only failure (the status check or the ahead/behind count
        // threw). Every probe throws when it cannot answer instead of
        // reporting "no" — a rev-list that failed to spawn must never read
        // as "diverged" — and the update is gated on success here, so a probe
        // error means we never touched the worktree: a skip, not a hard failure.
        // allSettled keeps the input order, so actions[index] is this worktree.
        // The git error names the command and its stderr but not the directory
        // it ran in, so the branch and path have to be logged and recorded from
        // here — otherwise a daemon watching hundreds of worktrees reports a
        // failed probe with nothing that says which one.
        const { branch, path: worktreePath } = actions[index];
        this.logger.error(`  - Error checking worktree '${branch}' (${worktreePath}):`, result.reason);
        outcome.recordSkipped("worktree", "update_check_failed", {
          branch,
          path: worktreePath,
          message: getErrorMessage(result.reason),
        });
      }
    });

    // Phase 4b: Perform mutations (updates + diverged handling) with lower concurrency
    const updateLimit = pLimit(
      this.config.parallelism?.maxWorktreeUpdates ?? DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_UPDATES,
    );

    const mutationTasks: Promise<{ type: "update" | "diverged"; branch: string; changed: boolean }>[] = [];

    for (const worktree of worktreesToUpdate) {
      mutationTasks.push(
        updateLimit(async () => {
          let changed = true;
          try {
            this.logger.info(`  - Updating worktree '${worktree.branch}'...`);
            const { updated } = await this.gitService.updateWorktree(worktree.path, worktree.branch);
            if (updated) {
              this.logger.info(`    ✅ Successfully updated '${worktree.branch}'.`);
              outcome.recordUpdated(worktree.branch, worktree.path, "fast_forward");
            } else {
              // Behind at the Phase 4a probe, but nothing left to merge once the
              // fast-forward ran: HEAD reached origin/<branch> in between (a
              // `git pull` in the worktree, say). Nothing changed here, so say
              // so rather than report an update that did not happen.
              this.logger.info(`    ℹ️  '${worktree.branch}' was already up to date; nothing to fast-forward.`);
              outcome.recordNoop("worktree", "already_up_to_date", worktree);
            }
          } catch (error) {
            const errorMessage = getErrorMessage(error);

            if (ERROR_MESSAGES.FAST_FORWARD_FAILED.some((msg) => errorMessage.includes(msg))) {
              this.logger.info(
                `    ⚠️ Branch '${worktree.branch}' cannot be fast-forwarded. Checking for divergence...`,
              );
              try {
                changed = await this.handleDivergedBranch(worktree, syncContext, outcome);
              } catch (divergedError) {
                this.logger.error(`    ❌ Failed to handle diverged branch '${worktree.branch}':`, divergedError);
                outcome.recordFailed("worktree", getErrorMessage(divergedError), {
                  reason: "diverged_recovery_failed",
                  branch: worktree.branch,
                  path: worktree.path,
                });
                throw divergedError;
              }
            } else {
              this.logger.error(`    ❌ Failed to update '${worktree.branch}':`, error);
              outcome.recordFailed("worktree", errorMessage, {
                reason: "update_failed",
                branch: worktree.branch,
                path: worktree.path,
              });
              throw error;
            }
          }
          return { type: "update" as const, branch: worktree.branch, changed };
        }),
      );
    }

    for (const worktree of divergedWorktrees) {
      mutationTasks.push(
        updateLimit(async () => {
          let changed: boolean;
          try {
            changed = await this.handleDivergedBranch(worktree, syncContext, outcome);
          } catch (error) {
            this.logger.error(`    ❌ Failed to handle diverged branch '${worktree.branch}':`, error);
            outcome.recordFailed("worktree", getErrorMessage(error), {
              reason: "diverged_recovery_failed",
              branch: worktree.branch,
              path: worktree.path,
            });
            throw error;
          }
          return { type: "diverged" as const, branch: worktree.branch, changed };
        }),
      );
    }

    if (mutationTasks.length > 0) {
      if (worktreesToUpdate.length > 0) {
        this.logger.info(`  - Found ${worktreesToUpdate.length} worktrees behind their upstream branches.`);
      }
      if (divergedWorktrees.length > 0) {
        this.logger.info(`  - Found ${divergedWorktrees.length} diverged worktrees to handle.`);
      }

      const mutationResults = await Promise.allSettled(mutationTasks);

      const successCount = mutationResults.filter((r) => r.status === "fulfilled" && r.value.changed).length;
      this.logger.info(`  Processed ${successCount}/${mutationTasks.length} worktrees successfully`);
    } else {
      this.logger.info("  - All worktrees are up to date.");
    }
  }

  private async handleDivergedBranch(
    worktree: { path: string; branch: string },
    syncContext: SyncRetryContext,
    outcome: SyncOutcomeAccumulator,
  ): Promise<boolean> {
    this.logger.info(`⚠️  Branch '${worktree.branch}' has diverged from upstream. Analyzing...`);

    if (await this.gitService.hasStashedChanges(worktree.path)) {
      this.logger.warn(
        `⚠️  Skipping diverged replace for '${worktree.branch}' because it has stashed changes. Pop/apply or drop the stash first.`,
      );
      outcome.recordSkipped("worktree", "stash_present", {
        branch: worktree.branch,
        path: worktree.path,
        message: "stashed changes present",
      });
      return false;
    }

    // The classification that got us here came from an ahead/behind count (or
    // a refused fast-forward) that ran a while ago, under high concurrency.
    // Before the reset or the move, confirm with a probe that throws when it
    // cannot answer that HEAD and origin/<branch> really have commits on both
    // sides. Anything else is re-classified and left for the next sync; a
    // probe that throws surfaces as diverged_recovery_failed at the call site.
    const counts = await this.gitService.getAheadBehindCounts(worktree.path, worktree.branch);
    if (counts.ahead === 0 || counts.behind === 0) {
      this.recordNotDiverged(worktree, outcome, counts);
      return false;
    }

    const observedHead = (await this.gitService.getCurrentCommit(worktree.path)).trim();
    const treesIdentical = await this.gitService.compareTreeContent(worktree.path, worktree.branch);

    const hasLocalChanges = treesIdentical
      ? false
      : await this.hasLocalChangesSinceLastSync(worktree.path, observedHead);
    if (
      (treesIdentical || !hasLocalChanges) &&
      (await this.gitService.resetToUpstream(worktree.path, worktree.branch, observedHead))
    ) {
      this.logger.info(`   Successfully updated '${worktree.branch}' to match upstream.`);
      outcome.recordUpdated(
        worktree.branch,
        worktree.path,
        treesIdentical ? "reset_identical_tree" : "reset_no_local_changes",
      );
      return true;
    }

    if (!hasLocalChanges) {
      this.logger.warn(
        `⚠️  Refusing to reset '${worktree.branch}' because the final safety check found local or ignored files that upstream would overwrite.`,
      );
    }
    this.logger.info(`🔒 Branch '${worktree.branch}' has diverged with local changes. Moving to diverged...`);

    const { divergedPath, keepRef, unregistered, trashEntry } = await this.divergeWorktree(
      worktree.path,
      worktree.branch,
    );
    const relativePath = path.relative(process.cwd(), divergedPath);
    outcome.recordPreservedDiverged(worktree.branch, worktree.path, divergedPath);

    this.logger.info(`   Moved to: ${relativePath}`);
    this.logger.info(`   Your local changes are preserved. To review:`);
    this.logger.info(`     cd ${relativePath}`);
    this.logger.info(`     git diff origin/${worktree.branch}`);

    if (!unregistered) {
      // force is safe here: the directory was already moved to .diverged/,
      // so only the stale registration is being cleared.
      await this.gitService.removeWorktree(worktree.path, { force: true });
      // Deliberately fatal on failure: addWorktree below would silently
      // recreate from the stale local branch instead of upstream.
      await this.gitService.deleteLocalBranch(worktree.branch);
      this.logger.info(
        `   Never-pushed commits remain recoverable at '${keepRef}' — recover with: git branch <name> ${keepRef}`,
      );
    }
    await this.removalAudit
      .record({
        action: "diverged_replace",
        result: "success",
        path: worktree.path,
        branch: worktree.branch,
        quarantinePath: divergedPath,
      })
      .catch((auditError: unknown) =>
        this.logger.warn(`  ⚠️ Failed to write removal audit record: ${getErrorMessage(auditError)}`),
      );
    await this.addWorktreeWithLfsFallback(worktree.branch, worktree.path, syncContext, outcome);
    this.logger.info(`   Created fresh worktree from upstream at: ${worktree.path}`);
    if (trashEntry) {
      // Best effort: if this does not land, the entry keeps reserving the branch
      // until it expires, which is visible in the reservation log line.
      await this.trashService
        .markReplacementCreated(trashEntry)
        .catch((error: unknown) =>
          this.logger.warn(
            `⚠️ Could not record the replacement for trash entry '${trashEntry.manifest.id}'; '${worktree.branch}' stays reserved until the entry expires: ${getErrorMessage(error)}`,
          ),
        );
    }
    return true;
  }

  // The re-verification in handleDivergedBranch found the worktree not
  // diverged after all: HEAD moved between the earlier probe and now (a pull
  // or a push in the worktree), or that probe answered on a spurious read.
  // Record what Phase 4a would say for the state seen now and touch nothing;
  // a worktree that is only behind is fast-forwarded on the next sync, through
  // the same sparse-checkout gate as any other.
  private recordNotDiverged(
    worktree: { path: string; branch: string },
    outcome: SyncOutcomeAccumulator,
    { ahead, behind }: AheadBehindCounts,
  ): void {
    const details = { branch: worktree.branch, path: worktree.path };
    const summary = `${ahead} ahead / ${behind} behind origin/${worktree.branch}`;
    if (ahead === 0 && behind === 0) {
      this.logger.info(
        `   '${worktree.branch}' is not diverged after all: HEAD is at origin/${worktree.branch}. Leaving it alone.`,
      );
      outcome.recordNoop("worktree", "already_up_to_date", details);
    } else if (behind === 0) {
      this.logger.info(`⏭️  Skipping '${worktree.branch}' - not diverged after all, has unpushed commits (${summary})`);
      outcome.recordSkipped("worktree", "local_ahead", { ...details, message: `not diverged: ${summary}` });
    } else {
      this.logger.info(
        `⏭️  Skipping '${worktree.branch}' - not diverged after all, only behind (${summary}); the next sync fast-forwards it`,
      );
      outcome.recordSkipped("worktree", "not_diverged", {
        ...details,
        message: `${summary}; fast-forwarded on the next sync`,
      });
    }
  }

  private async hasLocalChangesSinceLastSync(worktreePath: string, currentCommit?: string): Promise<boolean> {
    try {
      const metadata = await this.gitService.getWorktreeMetadata(worktreePath);
      if (!metadata || !metadata.lastSyncCommit) {
        return true;
      }

      const head = currentCommit ?? (await this.gitService.getCurrentCommit(worktreePath));
      return head !== metadata.lastSyncCommit;
    } catch {
      return true;
    }
  }

  private async divergeWorktree(
    worktreePath: string,
    branchName: string,
  ): Promise<{
    divergedPath: string;
    keepRef: string | null;
    unregistered: boolean;
    trashEntry: TrashEntry | null;
  }> {
    if (this.trashService.isEnabled()) {
      // keepPinOnReap: diverged-replace trashes the only copy of never-pushed
      // commits, so pin/bundle failure must abort while the worktree is intact.
      const { entry, branchRefError } = await this.trashService.trashAndUnregisterWorktree({
        dirPath: worktreePath,
        branch: branchName,
        reason: "diverged-replace",
        keepPinOnReap: true,
      });
      if (branchRefError) {
        throw new TrashOperationError(
          "diverged-replace",
          `cannot delete stale branch '${branchName}' after trashing: ${branchRefError}`,
        );
      }
      await this.writeDivergedInfoFile(entry.payloadPath, worktreePath, branchName, entry.manifest.headOid).catch(
        (error: unknown) =>
          this.logger.warn(
            `⚠️ Could not write diverged metadata for trash entry '${entry.manifest.id}': ${getErrorMessage(error)}`,
          ),
      );
      return { divergedPath: entry.payloadPath, keepRef: null, unregistered: true, trashEntry: entry };
    }

    const divergedBaseDir = path.join(this.config.worktreeDir, GIT_CONSTANTS.DIVERGED_DIR_NAME);

    const timestamp = new Date().toISOString().split("T")[0];
    const uniqueSuffix = Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
    const safeBranchName = this.pathResolution.sanitizeBranchName(branchName);
    const divergedName = `${timestamp}-${safeBranchName}-${uniqueSuffix}`;
    const divergedPath = path.join(divergedBaseDir, divergedName);
    const keepRef = `${GIT_CONSTANTS.KEEP_REF_PREFIX}${divergedName}`;
    const localCommit = (await this.gitService.getCurrentCommit(worktreePath)).trim();
    await this.gitService.updateRef(keepRef, localCommit);

    let moved = false;
    let crossDeviceCopyStarted = false;
    try {
      await fs.mkdir(divergedBaseDir, { recursive: true });
      try {
        await fs.rename(worktreePath, divergedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== ERROR_MESSAGES.EXDEV) throw error;
        crossDeviceCopyStarted = true;
        await fs.cp(worktreePath, divergedPath, { recursive: true });
        await fs.rm(worktreePath, { recursive: true, force: true });
      }
      moved = true;

      await this.writeDivergedInfoFile(divergedPath, worktreePath, branchName, localCommit, keepRef);
    } catch (error) {
      if (moved) {
        try {
          await fs.rename(divergedPath, worktreePath);
        } catch (rollbackError) {
          throw new TrashOperationError(
            "diverged-replace",
            `preserved files at '${divergedPath}' and commit at '${keepRef}' after rollback failed: ${getErrorMessage(rollbackError)}`,
            error instanceof Error ? error : undefined,
          );
        }
        await this.gitService
          .deleteRef(keepRef)
          .catch((refError: unknown) =>
            this.logger.warn(`⚠️ Failed to remove rollback keep ref '${keepRef}': ${getErrorMessage(refError)}`),
          );
      } else if (crossDeviceCopyStarted) {
        throw new TrashOperationError(
          "diverged-replace",
          `cross-device preservation failed; inspect '${worktreePath}' and '${divergedPath}'. Commit remains at '${keepRef}'`,
          error instanceof Error ? error : undefined,
        );
      } else {
        await this.gitService.deleteRef(keepRef).catch(() => undefined);
      }
      throw error;
    }

    return { divergedPath, keepRef, unregistered: false, trashEntry: null };
  }

  private async writeDivergedInfoFile(
    preservedPath: string,
    originalPath: string,
    branchName: string,
    knownLocalCommit: string | null,
    keepRef: string | null = null,
  ): Promise<void> {
    const metadata = {
      originalBranch: branchName,
      divergedAt: new Date().toISOString(),
      reason: METADATA_CONSTANTS.DIVERGED_REASON,
      originalPath,
      localCommit: knownLocalCommit ?? (await this.gitService.getCurrentCommit(preservedPath)),
      remoteCommit: await this.gitService.getRemoteCommit(`origin/${branchName}`),
      keepRef,
      // Two preservation mechanisms, two different ways back. A trashed copy is
      // restored through the trash CLI and has no keep ref to release; a
      // `.diverged/` copy is held only by its keep ref.
      instruction: `To preserve your changes:
  1. Review: git diff origin/${branchName}
  2. Keep changes: git push --force-with-lease origin ${branchName}
  3. Discard changes: ${
    keepRef
      ? "use the TUI worktree status view so the keep ref is released safely"
      : `restore it first with 'sync-worktrees trash --restore' if you want it back, then delete the entry`
  }

  Original worktree location: ${originalPath}`,
    };

    await fs.writeFile(
      path.join(preservedPath, METADATA_CONSTANTS.DIVERGED_INFO_FILE),
      JSON.stringify(metadata, null, 2),
    );
  }
}
