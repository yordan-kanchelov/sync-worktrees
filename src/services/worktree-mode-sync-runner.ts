import * as fs from "fs/promises";
import * as path from "path";

import pLimit from "p-limit";

import { DEFAULT_CONFIG, ERROR_MESSAGES, GIT_CONSTANTS, METADATA_CONSTANTS } from "../constants";
import { TrashOperationError, WorktreeNotCleanError } from "../errors";
import { filterBranchesByName } from "../utils/branch-filter";
import { filterBranchesByAge, formatDuration } from "../utils/date-filter";
import { probePathExists } from "../utils/file-exists";
import { findByWorktreePath, sameWorktreePath } from "../utils/path-compare";
import { getErrorMessage } from "../utils/errors";
import { isLfsError } from "../utils/lfs-error";
import { getRemovalAuditLogPath } from "../utils/lock-path";
import { copyTreePreservingSymlinks } from "../utils/preserving-copy";
import { detachGitLink } from "../utils/detach-git-link";

import { PathResolutionService } from "./path-resolution.service";
import { trackPhaseItems } from "./progress-emitter";
import { RemovalAuditService } from "./removal-audit.service";
import { TrashService } from "./trash.service";
import { RefScanScope } from "./worktree-status.service";
import { createWorktreeSyncPlan, listBranchesToCreate } from "./worktree-sync-planner";

import type { AddWorktreeResult, AheadBehindCounts, GitService, RegisteredWorktree } from "./git.service";
import type { Logger } from "./logger.service";
import type { ProgressEmitter } from "./progress-emitter";
import type { SyncOutcomeAccumulator } from "./sync-outcome";
import type { SyncDryRunPlanBuilder, SyncDryRunStep } from "./sync-plan";
import type { SyncRetryContext } from "./sync-retry-policy";
import type { TrashEntry } from "./trash.service";
import type { WorktreeStatusDetails, WorktreeStatusResult } from "./worktree-status.service";
import type { CreateAction, PruneAction, SparseAction, SyncPlan, UpdateAction } from "./worktree-sync-planner";
import type { Config, SparseCheckoutConfig } from "../types";
import type { PhaseTimer } from "../utils/timing";

export const PATH_CONTAINMENT_CONCURRENCY = 8;

type PruneAssessment =
  | { kind: "locked"; branch: string; path: string; lockReason?: string }
  | { kind: "check-failed"; branch: string; path: string; error: unknown }
  | {
      kind: "remove" | "keep-trash-disabled" | "keep-unsafe";
      branch: string;
      path: string;
      status: WorktreeStatusResult;
    };

type UpdateWorktreeRef = { path: string; branch: string; locked?: boolean; lockReason?: string };

type UpdateAssessment =
  | { action: "update"; worktree: UpdateWorktreeRef; behind: number }
  | { action: "diverged"; worktree: UpdateWorktreeRef }
  | { action: "skip" | "noop"; worktree: UpdateWorktreeRef; reason: string; message?: string }
  | { action: "check-failed"; worktree: UpdateWorktreeRef; error: unknown };

type DivergedAssessment =
  | { kind: "stash_present" }
  | { kind: "not_diverged"; counts: AheadBehindCounts }
  | { kind: "reset"; observedHead: string; treesIdentical: boolean }
  | { kind: "replace"; observedHead: string }
  | { kind: "locked"; lockReason?: string };

type SparseAssessment =
  | { kind: "absent" }
  | { kind: "in-sync" }
  | { kind: "apply"; narrowing: boolean }
  | { kind: "unsafe-narrowing"; reasons: string[] }
  | { kind: "failed"; error: unknown };

function lockedMessage(lockReason: string | undefined): string {
  return `worktree is locked${lockReason !== undefined ? `: ${lockReason}` : ""}`;
}

export class WorktreeModeSyncRunner {
  private pathResolution = new PathResolutionService();
  private removalAudit: RemovalAuditService;
  private trashService: TrashService;
  private remoteRefsPrunedThisAttempt = false;
  private warnedBadExpiry = new Set<string>();

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
    this.remoteRefsPrunedThisAttempt = false;
    await this.ensureFetchAnchor(outcome);
    await this.fetchLatestRemoteData(phaseTimer);

    await fs.mkdir(this.config.worktreeDir, { recursive: true });

    const { worktrees, syncPlan, anchorSkip } = await this.collectInventory((all) =>
      this.resolveDefaultBranch(all, outcome),
    );
    if (anchorSkip) {
      const { reason, ...details } = anchorSkip;
      this.logger.warn(`  ⏭️ ${details.message}`);
      outcome.recordSkipped("worktree", reason, details);
    }

    await this.createNewWorktreesWithTiming(syncPlan, phaseTimer, syncContext, outcome);
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
      await this.reapplySparseCheckoutWithTiming(syncPlan.sparse, phaseTimer, syncContext, outcome);
    }
  }

  async planSyncAttempt(plan: SyncDryRunPlanBuilder): Promise<void> {
    const anchorPath = this.gitService.getMainWorktreePath();
    if ((await probePathExists(anchorPath)) === "missing") {
      plan.add({
        kind: "create",
        branch: this.gitService.getDefaultBranch(),
        path: anchorPath,
        reason: "default_branch",
      });
    }

    const inventory = await this.collectInventory(async (all) => {
      const current = this.gitService.getDefaultBranch();
      if (!all.includes(current)) {
        plan.note(
          `Default branch '${current}' does not exist on origin; a sync re-resolves the default branch before planning, so its plan can differ from this one.`,
        );
      }
      return current;
    });
    const { syncPlan, allRemoteBranches, pendingDivergedBranches, rebuiltBranches } = inventory;
    if (inventory.anchorSkip) plan.add({ kind: "skip", scope: "worktree", ...inventory.anchorSkip });

    for (const worktree of inventory.externalWorktrees) {
      plan.add({
        kind: "skip",
        scope: "worktree",
        reason: "external_worktree",
        branch: worktree.branch,
        path: worktree.path,
        message: "registered outside worktreeDir; sync leaves it alone",
      });
    }
    for (const branch of pendingDivergedBranches) {
      plan.add({
        kind: "skip",
        scope: "branch",
        reason: "reserved_by_trash",
        branch,
        message: "a diverged-replace trash entry is waiting to be restored to this branch's path",
      });
    }

    for (const action of syncPlan.create) {
      if (action.kind === "skip-create") {
        plan.add({
          kind: "skip",
          scope: "branch",
          reason: "path_collision",
          branch: action.branch,
          path: action.path,
          message: `Path collides with existing branch '${action.conflictingBranch}'`,
        });
      } else {
        plan.add({
          kind: "create",
          branch: action.branch,
          path: action.path,
          reason: rebuiltBranches.has(action.branch) ? "missing_directory" : "new_branch",
        });
      }
    }

    const prunes = await this.assessPrune(syncPlan.prune);
    for (const assessment of prunes) {
      plan.add(
        await this.describePruneAssessment(assessment, (branch) =>
          pendingDivergedBranches.has(branch)
            ? "reserved_by_trash"
            : allRemoteBranches.has(branch)
              ? "excluded_by_filters"
              : "deleted_on_remote",
        ),
      );
    }

    if (this.config.updateExistingWorktrees !== false) {
      const remoteTips = await this.readRemoteBranchTips();
      const updates = await this.assessUpdates(syncPlan.update, remoteTips);
      for (const [index, assessment] of updates.entries()) {
        plan.add(await this.describeUpdateAssessment(assessment, syncPlan.update[index]));
      }
    }

    const sparseConfig = this.config.sparseCheckout;
    if (sparseConfig) {
      const sparseService = this.gitService.getSparseCheckoutService();
      const desired = sparseService.buildPatterns(sparseConfig);
      for (const action of syncPlan.sparse) {
        const assessment = await this.assessSparseAction(action, sparseConfig, desired);
        const step = this.describeSparseAssessment(action, assessment);
        if (step) plan.add(step);
      }
    }
  }

  private async collectInventory(resolveDefault: (allRemoteBranches: string[]) => Promise<string>): Promise<{
    syncPlan: SyncPlan;
    worktrees: RegisteredWorktree[];
    externalWorktrees: RegisteredWorktree[];
    allRemoteBranches: Set<string>;
    pendingDivergedBranches: Set<string>;
    rebuiltBranches: Set<string>;
    anchorSkip?: { reason: string; branch: string; path: string; message: string };
  }> {
    const { all, remoteBranches, defaultBranch } = await this.resolveSyncBranches(resolveDefault);
    const pendingDivergedBranches = await this.getPendingDivergedBranches();

    const registeredWorktrees = await this.gitService.getWorktrees();
    const anchorSkip = await this.assessAnchorBranch(registeredWorktrees, defaultBranch);
    const { worktrees, externalWorktrees } = await this.partitionByWorktreeDir(registeredWorktrees);
    const externalBranches = new Set(externalWorktrees.map((worktree) => worktree.branch));
    const plannedBranches = remoteBranches.filter(
      (branch) => !externalBranches.has(branch) && !pendingDivergedBranches.has(branch),
    );
    const rebuiltBranches = await this.dropStaleRegistrations(worktrees, new Set(plannedBranches));
    this.logger.info(`Found ${worktrees.length} managed Git worktrees.`);
    for (const worktree of externalWorktrees) {
      this.logger.warn(`  - Skipping external worktree outside worktreeDir: ${worktree.path}`);
    }

    const planInput = {
      remoteBranches: plannedBranches,
      defaultBranch,
      existingWorktrees: worktrees,
      worktreeDir: this.config.worktreeDir,
    };
    const naming = await this.pathResolution.createProbedNamingContext(
      {
        branches: all,
        branchesToName: listBranchesToCreate(planInput),
        defaultBranch,
        worktrees: registeredWorktrees,
      },
      {
        worktreeDir: this.config.worktreeDir,
        bareRepoPath: this.gitService.getBareRepoPath(),
        readMetadataOwner: (name) => this.gitService.readWorktreeMetadataOwner(name),
      },
    );
    const syncPlan = createWorktreeSyncPlan(planInput, {
      naming,
      pathResolution: this.pathResolution,
      updateExistingWorktrees: this.config.updateExistingWorktrees !== false,
      sparseCheckout: this.config.sparseCheckout,
    });
    if (anchorSkip) {
      const kept: PruneAction[] = [];
      for (const action of syncPlan.prune) {
        if (!(await sameWorktreePath(action.path, anchorSkip.path))) kept.push(action);
      }
      syncPlan.prune = kept;
    }

    return {
      syncPlan,
      worktrees,
      externalWorktrees,
      allRemoteBranches: new Set(all),
      pendingDivergedBranches,
      rebuiltBranches,
      anchorSkip,
    };
  }

  private async assessAnchorBranch(
    registered: RegisteredWorktree[],
    defaultBranch: string,
  ): Promise<{ reason: string; branch: string; path: string; message: string } | undefined> {
    const anchorPath = this.gitService.getMainWorktreePath();
    if ((await probePathExists(anchorPath)) !== "exists") return undefined;
    const entry = await findByWorktreePath(registered, anchorPath);
    if (entry?.branch === defaultBranch) return undefined;
    const fix = `check '${defaultBranch}' back out there to have it synced again`;
    return entry
      ? {
          reason: "default_branch_mismatch",
          branch: defaultBranch,
          path: anchorPath,
          message: `Default-branch worktree at '${anchorPath}' has '${entry.branch}' checked out, so '${defaultBranch}' is not synced; ${fix}`,
        }
      : {
          reason: "default_branch_detached",
          branch: defaultBranch,
          path: anchorPath,
          message: `Default-branch worktree at '${anchorPath}' is on a detached HEAD, so '${defaultBranch}' is not synced; ${fix}`,
        };
  }

  private async reapplySparseCheckoutWithTiming(
    actions: SparseAction[],
    phaseTimer: PhaseTimer,
    syncContext: SyncRetryContext,
    outcome: SyncOutcomeAccumulator,
  ): Promise<void> {
    phaseTimer.startPhase("Phase 5: Sparse");

    await this.reapplySparseCheckout(actions, syncContext, outcome);

    phaseTimer.setPhaseCount("Phase 5: Sparse", actions.length);
    phaseTimer.endPhase();
  }

  private async reapplySparseCheckout(
    actions: SparseAction[],
    syncContext: SyncRetryContext,
    outcome: SyncOutcomeAccumulator,
  ): Promise<void> {
    const sparseConfig = this.config.sparseCheckout;
    if (!sparseConfig) return;

    this.logger.info("Step 5: Reconciling sparse-checkout patterns on existing worktrees...");
    this.progressEmitter.emit({ phase: "sparse", message: "Reconciling sparse-checkout patterns" });
    const sparseService = this.gitService.getSparseCheckoutService();
    const desired = sparseService.buildPatterns(sparseConfig);

    const limit = pLimit(this.config.parallelism?.maxStatusChecks ?? DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS);
    const itemDone = trackPhaseItems(this.progressEmitter, "sparse", "Reconciling sparse-checkout", actions.length);

    await Promise.all(
      actions.map((action) =>
        limit(async () => {
          const assessment = await this.assessSparseAction(action, sparseConfig, desired);
          try {
            switch (assessment.kind) {
              case "absent":
              case "in-sync":
                return;
              case "failed":
                throw assessment.error;
              case "unsafe-narrowing":
                this.logger.warn(
                  `  - Skipping sparse-checkout narrowing for '${action.branch}': ${assessment.reasons.join(", ")}.`,
                );
                outcome.recordSkipped("sparse-checkout", "sparse_narrowing_unsafe", {
                  branch: action.branch,
                  path: action.path,
                  message: assessment.reasons.join(", "),
                });
                return;
              case "apply":
                await this.withLfsFallback(action.branch, action.path, syncContext, outcome, async () => {
                  await sparseService.applyToWorktree(action.path, sparseConfig);
                  await this.gitService.checkoutHead(action.path);
                });
                this.logger.info(`  - ✅ Sparse-checkout updated for '${action.branch}'`);
                outcome.recordUpdated(action.branch, action.path, "sparse_checkout");
                return;
            }
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
        }).finally(() => itemDone(action.branch)),
      ),
    );
  }

  private async assessSparseAction(
    action: { branch: string; path: string },
    sparseConfig: SparseCheckoutConfig,
    desired: string[],
  ): Promise<SparseAssessment> {
    const sparseService = this.gitService.getSparseCheckoutService();
    try {
      try {
        await fs.access(action.path);
      } catch {
        return { kind: "absent" };
      }

      const desiredMode = sparseService.resolveMode(sparseConfig);
      const currentMode = await sparseService.readCurrentMode(action.path);
      const current = await sparseService.readCurrent(action.path, currentMode);
      if (currentMode === desiredMode && current !== null && sparseService.patternsEqual(current, desired)) {
        return { kind: "in-sync" };
      }

      const narrowing = sparseService.isNarrowing(current, desired, currentMode, desiredMode);
      if (narrowing) {
        const status = await this.gitService.getFullWorktreeStatus(action.path, false);
        if (!status.canRemove) return { kind: "unsafe-narrowing", reasons: status.reasons };
      }
      return { kind: "apply", narrowing };
    } catch (error) {
      return { kind: "failed", error };
    }
  }

  private describeSparseAssessment(
    action: { branch: string; path: string },
    assessment: SparseAssessment,
  ): SyncDryRunStep | null {
    const details = { branch: action.branch, path: action.path };
    switch (assessment.kind) {
      case "absent":
      case "in-sync":
        return null;
      case "unsafe-narrowing":
        return {
          kind: "skip",
          scope: "sparse-checkout",
          reason: "sparse_narrowing_unsafe",
          ...details,
          message: assessment.reasons.join(", "),
        };
      case "failed":
        return {
          kind: "skip",
          scope: "sparse-checkout",
          reason: "sparse_check_failed",
          ...details,
          message: getErrorMessage(assessment.error),
        };
      case "apply":
        return {
          kind: "update",
          ...details,
          reason: "sparse_checkout",
          message: assessment.narrowing
            ? "narrows the sparse-checkout patterns"
            : "rewrites the sparse-checkout patterns",
        };
    }
  }

  private async partitionByWorktreeDir<T extends { path: string }>(
    registeredWorktrees: T[],
  ): Promise<{ worktrees: T[]; externalWorktrees: T[] }> {
    if (registeredWorktrees.length === 0) {
      return { worktrees: [], externalWorktrees: [] };
    }
    const resolvedWorktreeDir = await this.pathResolution.resolveBaseDir(this.config.worktreeDir);
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

  private async dropStaleRegistrations(
    worktrees: { path: string; branch: string }[],
    plannedBranches: Set<string>,
  ): Promise<Set<string>> {
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
    return new Set(stale.map((worktree) => worktree.branch));
  }

  private async getPendingDivergedBranches(): Promise<Set<string>> {
    const pending = new Set<string>();
    if (!this.trashService.isEnabled()) return pending;

    const { entries } = await this.trashService.listEntries();
    const now = Date.now();
    for (const { manifest } of entries) {
      if (manifest.reason !== "diverged-replace" || !manifest.branch || manifest.replacedAt) continue;
      const expiresAt = Date.parse(manifest.expiresAt);
      if (Number.isNaN(expiresAt)) {
        if (!this.warnedBadExpiry.has(manifest.id)) {
          this.warnedBadExpiry.add(manifest.id);
          this.logger.warn(
            `  - Trash entry '${manifest.id}' has an unparseable expiry (${manifest.expiresAt}); not reserving '${manifest.branch}'.`,
          );
        }
        continue;
      }
      if (expiresAt > now && (await probePathExists(manifest.originalPath)) === "missing") {
        pending.add(manifest.branch);
        this.logger.info(
          `  - Reserving '${manifest.originalPath}' for trash entry '${manifest.id}'; '${manifest.branch}' stays unsynced until it is restored or expires (${manifest.expiresAt}).`,
        );
      }
    }

    return pending;
  }

  private async ensureFetchAnchor(outcome: SyncOutcomeAccumulator): Promise<void> {
    if (!(await this.gitService.ensureAnchorWorktree())) return;

    const branch = this.gitService.getDefaultBranch();
    const anchorPath = this.gitService.getMainWorktreePath();
    this.logger.info(`  ✅ Recreated the '${branch}' worktree at '${anchorPath}'`);
    outcome.recordCreated(branch, anchorPath);
  }

  didPruneAllRemoteRefs(): boolean {
    return this.remoteRefsPrunedThisAttempt;
  }

  private async fetchLatestRemoteData(phaseTimer: PhaseTimer): Promise<void> {
    this.logger.info("Step 1: Fetching latest data from remote...");
    phaseTimer.startPhase("Phase 1: Fetch");
    this.progressEmitter.emit({ phase: "fetch", message: "Fetching latest data from remote" });

    try {
      await this.gitService.fetchAll();
      this.remoteRefsPrunedThisAttempt = true;
    } finally {
      phaseTimer.endPhase();
    }
  }

  private async resolveSyncBranches(
    resolveDefault: (allRemoteBranches: string[]) => Promise<string>,
  ): Promise<{ all: string[]; remoteBranches: string[]; defaultBranch: string }> {
    const { all, filtered: remoteBranches } = this.config.branchMaxAge
      ? await this.getRemoteBranchesFilteredByActivity()
      : await this.getRemoteBranchesFilteredByName();
    const defaultBranch = await resolveDefault(all);

    if (!all.includes(defaultBranch)) {
      this.logger.warn(`Default branch '${defaultBranch}' does not exist on origin; not retaining its worktree.`);
    } else if (!remoteBranches.includes(defaultBranch)) {
      remoteBranches.push(defaultBranch);
      this.logger.info(`Ensuring default branch '${defaultBranch}' is retained.`);
    }

    return { all, remoteBranches, defaultBranch };
  }

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
    const filteredBranches = filterBranchesByAge(filteredByName, this.config.branchMaxAge!, this.logger);
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

    const maxConcurrent =
      this.config.parallelism?.maxWorktreeCreation ?? DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_CREATION;
    const limit = pLimit(maxConcurrent);
    const itemDone = trackPhaseItems(this.progressEmitter, "create", "Creating worktrees", plan.length);

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

          this.logger.info(`  ✅ Created worktree for '${branchName}'`);
          outcome.recordCreated(branchName, worktreePath);
          if (addResult.status === "created") {
            await this.verifyCreatedWorktreeTip(branchName, worktreePath, addResult.head, outcome);
          }
          return true;
        }).finally(() => itemDone(branchName)),
      ),
    );

    const successCount = results.filter((r) => r.status === "fulfilled" && r.value).length;
    this.logger.info(`  Created ${successCount}/${plan.length} worktrees successfully`);
  }

  private async addWorktreeWithLfsFallback(
    branchName: string,
    worktreePath: string,
    syncContext: SyncRetryContext,
    outcome: SyncOutcomeAccumulator,
  ): Promise<AddWorktreeResult> {
    return this.withLfsFallback(branchName, worktreePath, syncContext, outcome, () =>
      this.gitService.addWorktree(branchName, worktreePath),
    );
  }

  private async withLfsFallback<T>(
    branchName: string,
    worktreePath: string,
    syncContext: SyncRetryContext,
    outcome: SyncOutcomeAccumulator,
    operation: () => Promise<T>,
  ): Promise<T> {
    const skipAlreadyEnabled = this.config.skipLfs === true || syncContext.lfsSkipEnabled;

    try {
      return await operation();
    } catch (error) {
      if (skipAlreadyEnabled || !isLfsError(getErrorMessage(error))) throw error;

      this.logger.warn(`  - ⚠️ LFS checkout failed for '${branchName}': ${getErrorMessage(error)}`);
      this.enableLfsSkipForSync(syncContext, outcome, branchName, worktreePath);
      return await operation();
    }
  }

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

  private async readRemoteBranchTips(): Promise<Map<string, string> | null> {
    try {
      return await this.gitService.getRemoteBranchTips();
    } catch (error) {
      this.logger.warn(`⚠️ Could not read remote branch tips: ${getErrorMessage(error)}`);
      return null;
    }
  }

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
    const assessments = await this.assessPrune(actions);

    const toRemove: Array<{ branchName: string; worktreePath: string }> = [];
    const toSkip: Array<{ branchName: string; worktreePath: string; status: WorktreeStatusResult }> = [];
    let checked = 0;
    for (const assessment of assessments) {
      const branchName = assessment.branch;
      const worktreePath = assessment.path;
      switch (assessment.kind) {
        case "locked": {
          const because = assessment.lockReason !== undefined ? `: ${assessment.lockReason}` : "";
          this.logger.info(
            `  - 🔒 Skipping removal of '${branchName}' - the worktree is locked${because}. To let sync remove it: git worktree unlock ${worktreePath}`,
          );
          outcome.recordSkipped("worktree", "worktree_locked", {
            branch: branchName,
            path: worktreePath,
            message: `worktree is locked${because}`,
          });
          continue;
        }
        case "remove":
          toRemove.push({ branchName, worktreePath });
          break;
        case "keep-trash-disabled":
          this.logger.warn(
            `  - ⚠️ '${branchName}' was fully pushed before its remote branch was deleted, but trash is disabled — keeping worktree. Enable trash for reversible auto-removal, or remove manually.`,
          );
          outcome.recordSkipped("worktree", "fully_pushed_trash_disabled", {
            branch: branchName,
            path: worktreePath,
            message: "fully pushed before upstream deletion; trash disabled",
          });
          break;
        case "keep-unsafe":
          toSkip.push({ branchName, worktreePath, status: assessment.status });
          break;
        case "check-failed":
          this.logger.error(`  - Error checking worktree '${branchName}' (${worktreePath}):`, assessment.error);
          this.logger.warn(`  - ⚠️ Skipping removal of '${branchName}' due to status check failure (conservative)`);
          outcome.recordSkipped("worktree", "prune_status_check_failed", {
            branch: branchName,
            path: worktreePath,
            message: getErrorMessage(assessment.error),
          });
          break;
      }
      checked++;
    }

    if (checked > 0) {
      if (toRemove.length > 0) {
        const removeLimit = pLimit(
          this.config.parallelism?.maxWorktreeRemoval ?? DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_REMOVAL,
        );

        const removeDone = trackPhaseItems(this.progressEmitter, "prune", "Pruning stale worktrees", toRemove.length);

        const removeResults = await Promise.allSettled(
          toRemove.map(({ branchName, worktreePath }) =>
            removeLimit(async () => {
              try {
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
            }).finally(() => removeDone(branchName)),
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

  private async assessPrune(actions: PruneAction[]): Promise<PruneAssessment[]> {
    const assessments: PruneAssessment[] = [];
    const checks: Array<{ branch: string; path: string }> = [];
    for (const action of actions) {
      if (action.kind === "skip-prune") {
        assessments.push({
          kind: "locked",
          branch: action.branch,
          path: action.path,
          ...(action.lockReason !== undefined && { lockReason: action.lockReason }),
        });
        continue;
      }
      checks.push({ branch: action.branch, path: action.path });
    }
    if (checks.length === 0) return assessments;

    this.logger.info(`Step 3: Checking ${checks.length} stale worktrees to prune...`);

    const maxConcurrent = this.config.parallelism?.maxStatusChecks ?? DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS;
    const limit = pLimit(maxConcurrent);
    const checkDone = trackPhaseItems(this.progressEmitter, "prune", "Checking worktrees to prune", checks.length);

    const refScans = new RefScanScope();
    const statusResults = await Promise.allSettled(
      checks.map(({ branch, path: worktreePath }) =>
        limit(async () => this.gitService.getFullWorktreeStatus(worktreePath, this.config.debug, refScans)).finally(
          () => checkDone(branch),
        ),
      ),
    );

    statusResults.forEach((result, index) => {
      const { branch, path: worktreePath } = checks[index];
      if (result.status === "rejected") {
        assessments.push({ kind: "check-failed", branch, path: worktreePath, error: result.reason });
        return;
      }
      const status = result.value;
      const kind = !status.canRemove
        ? "keep-unsafe"
        : this.blockedByDisabledTrash(status)
          ? "keep-trash-disabled"
          : "remove";
      assessments.push({ kind, branch, path: worktreePath, status });
    });
    return assessments;
  }

  private async describePruneAssessment(
    assessment: PruneAssessment,
    whyUnwanted: (branch: string) => Extract<SyncDryRunStep, { kind: "remove" }>["reason"],
  ): Promise<SyncDryRunStep> {
    const details = { branch: assessment.branch, path: assessment.path };
    switch (assessment.kind) {
      case "locked": {
        const because = assessment.lockReason !== undefined ? `: ${assessment.lockReason}` : "";
        return {
          kind: "skip",
          scope: "worktree",
          reason: "worktree_locked",
          ...details,
          message: `worktree is locked${because}`,
        };
      }
      case "check-failed":
        return {
          kind: "skip",
          scope: "worktree",
          reason: "prune_status_check_failed",
          ...details,
          message: getErrorMessage(assessment.error),
        };
      case "keep-trash-disabled":
        return {
          kind: "skip",
          scope: "worktree",
          reason: "fully_pushed_trash_disabled",
          ...details,
          message: "fully pushed before upstream deletion; trash disabled",
        };
      case "keep-unsafe":
        return {
          kind: "skip",
          scope: "worktree",
          reason: "unsafe_to_remove",
          ...details,
          message: assessment.status.reasons.join(", "),
        };
      case "remove": {
        const reason = whyUnwanted(assessment.branch);
        const basis =
          (await probePathExists(assessment.path)) === "missing"
            ? "directory_missing"
            : assessment.status.fullyPushedUpstreamDeleted
              ? "fully_pushed_remote_deleted"
              : "clean_and_pushed";
        const disposal = this.trashService.isEnabled() && basis !== "directory_missing" ? "trash" : "delete";
        const why =
          reason === "deleted_on_remote"
            ? "remote branch deleted"
            : reason === "excluded_by_filters"
              ? "excluded by branchInclude/branchExclude/branchMaxAge"
              : "reserved by a trash entry";
        const because =
          basis === "fully_pushed_remote_deleted"
            ? "fully pushed, remote branch deleted"
            : basis === "directory_missing"
              ? `${why}; directory already gone`
              : `${why}; clean, every commit is on a remote`;
        const where =
          disposal === "trash"
            ? "moved to trash"
            : basis === "directory_missing"
              ? "registration cleared"
              : "deleted (trash disabled)";
        return { kind: "remove", ...details, reason, basis, disposal, message: `${because}; ${where}` };
      }
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
    } catch {}

    const checkResults = await this.assessUpdates(actions, remoteTips);

    const worktreesToUpdate: UpdateWorktreeRef[] = [];
    const divergedWorktrees: UpdateWorktreeRef[] = [];

    checkResults.forEach((result) => {
      switch (result.action) {
        case "update":
          worktreesToUpdate.push(result.worktree);
          break;
        case "diverged":
          divergedWorktrees.push(result.worktree);
          break;
        case "noop":
          outcome.recordNoop("worktree", result.reason, result.worktree);
          break;
        case "skip":
          outcome.recordSkipped("worktree", result.reason, result.worktree);
          break;
        case "check-failed": {
          const { branch, path: worktreePath } = result.worktree;
          this.logger.error(`  - Error checking worktree '${branch}' (${worktreePath}):`, result.error);
          outcome.recordSkipped("worktree", "update_check_failed", {
            branch,
            path: worktreePath,
            message: getErrorMessage(result.error),
          });
          break;
        }
      }
    });

    await this.applyUpdates(worktreesToUpdate, divergedWorktrees, syncContext, outcome);
  }

  private async assessUpdates(
    actions: UpdateAction[],
    remoteTips: Map<string, string> | null,
  ): Promise<UpdateAssessment[]> {
    const maxConcurrent = this.config.parallelism?.maxStatusChecks ?? DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS;
    const limit = pLimit(maxConcurrent);
    const checkDone = trackPhaseItems(this.progressEmitter, "update", "Checking worktrees for updates", actions.length);

    const checkResults = await Promise.allSettled(
      actions.map((action) =>
        limit(async (): Promise<UpdateAssessment> => {
          const worktree: UpdateWorktreeRef = {
            path: action.path,
            branch: action.branch,
            ...(action.locked === true && { locked: true }),
            ...(action.lockReason !== undefined && { lockReason: action.lockReason }),
          };

          try {
            await fs.access(worktree.path);
          } catch {
            return { action: "skip", worktree, reason: "missing_worktree_path" };
          }

          const hasOp = await this.gitService.hasOperationInProgress(worktree.path);
          if (hasOp) return { action: "skip", worktree, reason: "operation_in_progress" };

          const remoteTip = remoteTips?.get(worktree.branch);
          if (remoteTip !== undefined && action.head === remoteTip) {
            return { action: "noop", worktree, reason: "already_up_to_date" };
          }

          const isClean = await this.gitService.checkWorktreeStatus(worktree.path);
          if (!isClean) return { action: "skip", worktree, reason: "dirty_worktree" };

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
              if (diff !== null && !sparseService.pathsTouchSparse(diff, sparseCfg)) {
                this.logger.info(`⏭️  Skipping '${worktree.branch}' - upstream changes outside sparse paths`);
                return { action: "skip", worktree, reason: "outside_sparse_checkout" };
              }
            }
          }

          return { action: "update", worktree, behind };
        }).finally(() => checkDone(action.branch)),
      ),
    );

    return checkResults.map((result, index) =>
      result.status === "fulfilled"
        ? result.value
        : {
            action: "check-failed",
            worktree: { path: actions[index].path, branch: actions[index].branch },
            error: result.reason as unknown,
          },
    );
  }

  private async describeUpdateAssessment(assessment: UpdateAssessment, action: UpdateAction): Promise<SyncDryRunStep> {
    const details = { branch: action.branch, path: action.path };
    switch (assessment.action) {
      case "update":
        return {
          kind: "update",
          ...details,
          reason: "fast_forward",
          message: `${assessment.behind} commit${assessment.behind === 1 ? "" : "s"} behind origin/${action.branch}`,
        };
      case "noop":
        return { kind: "noop", scope: "worktree", reason: assessment.reason, ...details };
      case "skip":
        return { kind: "skip", scope: "worktree", reason: assessment.reason, ...details };
      case "check-failed":
        return {
          kind: "skip",
          scope: "worktree",
          reason: "update_check_failed",
          ...details,
          message: getErrorMessage(assessment.error),
        };
      case "diverged": {
        let diverged: DivergedAssessment;
        try {
          diverged = await this.assessDiverged(assessment.worktree);
        } catch (error) {
          return {
            kind: "skip",
            scope: "worktree",
            reason: "diverged_check_failed",
            ...details,
            message: getErrorMessage(error),
          };
        }
        return this.describeDivergedAssessment(details, diverged);
      }
    }
  }

  private describeDivergedAssessment(
    details: { branch: string; path: string },
    assessment: DivergedAssessment,
  ): SyncDryRunStep {
    switch (assessment.kind) {
      case "stash_present":
        return {
          kind: "skip",
          scope: "worktree",
          reason: "stash_present",
          ...details,
          message: "diverged, but has stashed changes",
        };
      case "not_diverged": {
        const { ahead, behind } = assessment.counts;
        if (ahead === 0 && behind === 0)
          return { kind: "noop", scope: "worktree", reason: "already_up_to_date", ...details };
        if (behind === 0) return { kind: "skip", scope: "worktree", reason: "local_ahead", ...details };
        return {
          kind: "skip",
          scope: "worktree",
          reason: "not_diverged",
          ...details,
          message: `${ahead} ahead / ${behind} behind origin/${details.branch}; fast-forwarded on the next sync`,
        };
      }
      case "reset":
        return {
          kind: "update",
          ...details,
          reason: assessment.treesIdentical ? "reset_identical_tree" : "reset_no_local_changes",
          message: assessment.treesIdentical
            ? `diverged, but the files match origin/${details.branch}; reset to it`
            : `diverged with no local changes since the last sync; reset to origin/${details.branch}`,
        };
      case "replace": {
        const preservedIn = this.trashService.isEnabled() ? "trash" : "diverged_dir";
        return {
          kind: "replace",
          ...details,
          reason: "diverged_local_changes",
          preservedIn,
          message: `diverged with local changes; moved to ${preservedIn === "trash" ? "trash" : GIT_CONSTANTS.DIVERGED_DIR_NAME + "/"} and recreated from origin/${details.branch}`,
        };
      }
      case "locked":
        return {
          kind: "skip",
          scope: "worktree",
          reason: "worktree_locked",
          ...details,
          message: lockedMessage(assessment.lockReason),
        };
    }
  }

  private async applyUpdates(
    worktreesToUpdate: UpdateWorktreeRef[],
    divergedWorktrees: UpdateWorktreeRef[],
    syncContext: SyncRetryContext,
    outcome: SyncOutcomeAccumulator,
  ): Promise<void> {
    const updateLimit = pLimit(
      this.config.parallelism?.maxWorktreeUpdates ?? DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_UPDATES,
    );

    const mutationTasks: Promise<{ type: "update" | "diverged"; branch: string; changed: boolean }>[] = [];
    const mutationDone = trackPhaseItems(
      this.progressEmitter,
      "update",
      "Updating worktrees",
      worktreesToUpdate.length + divergedWorktrees.length,
    );

    for (const worktree of worktreesToUpdate) {
      mutationTasks.push(
        updateLimit(async () => {
          let changed = true;
          try {
            this.logger.info(`  - Updating worktree '${worktree.branch}'...`);
            const { updated } = await this.withLfsFallback(worktree.branch, worktree.path, syncContext, outcome, () =>
              this.gitService.updateWorktree(worktree.path, worktree.branch),
            );
            if (updated) {
              this.logger.info(`    ✅ Successfully updated '${worktree.branch}'.`);
              outcome.recordUpdated(worktree.branch, worktree.path, "fast_forward");
            } else {
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
        }).finally(() => mutationDone(worktree.branch)),
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
        }).finally(() => mutationDone(worktree.branch)),
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
    worktree: UpdateWorktreeRef,
    syncContext: SyncRetryContext,
    outcome: SyncOutcomeAccumulator,
  ): Promise<boolean> {
    const assessment = await this.assessDiverged(worktree);

    if (assessment.kind === "locked") {
      this.recordDivergedLocked(worktree, outcome);
      return false;
    }

    if (assessment.kind === "stash_present") {
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

    if (assessment.kind === "not_diverged") {
      this.recordNotDiverged(worktree, outcome, assessment.counts);
      return false;
    }

    const { observedHead } = assessment;
    const hasLocalChanges = assessment.kind === "replace";
    if (
      assessment.kind === "reset" &&
      (await this.gitService.resetToUpstream(worktree.path, worktree.branch, observedHead))
    ) {
      this.logger.info(`   Successfully updated '${worktree.branch}' to match upstream.`);
      outcome.recordUpdated(
        worktree.branch,
        worktree.path,
        assessment.treesIdentical ? "reset_identical_tree" : "reset_no_local_changes",
      );
      return true;
    }

    if (!hasLocalChanges) {
      this.logger.warn(
        `⚠️  Refusing to reset '${worktree.branch}' because the final safety check found local or ignored files that upstream would overwrite.`,
      );
      if (worktree.locked) {
        this.recordDivergedLocked(worktree, outcome);
        return false;
      }
    }
    this.logger.info(`🔒 Branch '${worktree.branch}' has diverged with local changes. Moving to diverged...`);

    const { divergedPath, keepRef, unregistered, trashEntry } = await this.divergeWorktree(
      worktree.path,
      worktree.branch,
    );
    const relativePath = path.relative(process.cwd(), divergedPath);
    outcome.recordPreservedDiverged(worktree.branch, worktree.path, divergedPath);

    this.logger.info(`   Moved to: ${relativePath} (detached from git; do not run git inside it)`);

    if (!unregistered) {
      await this.gitService.removeWorktree(worktree.path, { force: true });
      await detachGitLink(divergedPath).catch((error: unknown) =>
        this.logger.warn(`⚠️ Could not detach the .git link of '${divergedPath}': ${getErrorMessage(error)}`),
      );
      await this.gitService.deleteLocalBranch(worktree.branch);
    }
    const recoverRef = keepRef ?? trashEntry?.manifest.headOid;
    if (recoverRef) {
      this.logger.info(
        `   Your commits are preserved. Recover them with: ${this.recoverCommand(worktree.branch, recoverRef)}`,
      );
    }
    if (trashEntry) {
      this.logger.info(
        `   Get the files back with: sync-worktrees trash restore ${trashEntry.manifest.id} (remove the replacement worktree and its branch first)`,
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

  private async assessDiverged(worktree: UpdateWorktreeRef): Promise<DivergedAssessment> {
    this.logger.info(`⚠️  Branch '${worktree.branch}' has diverged from upstream. Analyzing...`);

    if (await this.gitService.hasStashedChanges(worktree.path)) return { kind: "stash_present" };

    const counts = await this.gitService.getAheadBehindCounts(worktree.path, worktree.branch);
    if (counts.ahead === 0 || counts.behind === 0) return { kind: "not_diverged", counts };

    const observedHead = (await this.gitService.getCurrentCommit(worktree.path)).trim();
    const treesIdentical = await this.gitService.compareTreeContent(worktree.path, worktree.branch);
    const hasLocalChanges = treesIdentical
      ? false
      : await this.hasLocalChangesSinceLastSync(worktree.path, observedHead);
    if (!hasLocalChanges) return { kind: "reset", observedHead, treesIdentical };
    if (worktree.locked) {
      return { kind: "locked", ...(worktree.lockReason !== undefined && { lockReason: worktree.lockReason }) };
    }
    return { kind: "replace", observedHead };
  }

  private recordDivergedLocked(worktree: UpdateWorktreeRef, outcome: SyncOutcomeAccumulator): void {
    const message = lockedMessage(worktree.lockReason);
    this.logger.info(
      `  - 🔒 Skipping diverged replace of '${worktree.branch}' - the ${message}. To let sync replace it: git worktree unlock ${worktree.path}`,
    );
    outcome.recordSkipped("worktree", "worktree_locked", {
      branch: worktree.branch,
      path: worktree.path,
      message: `diverged, but ${message}`,
    });
  }

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
      await this.writeDivergedInfoFile(
        entry.containerPath,
        worktreePath,
        branchName,
        entry.manifest.headOid,
        null,
        entry.manifest.id,
      ).catch((error: unknown) =>
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
        await copyTreePreservingSymlinks(worktreePath, divergedPath);
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
        await this.gitService
          .deleteRef(keepRef)
          .catch((refError: unknown) =>
            this.logger.warn(`⚠️ Failed to remove rollback keep ref '${keepRef}': ${getErrorMessage(refError)}`),
          );
      }
      throw error;
    }

    return { divergedPath, keepRef, unregistered: false, trashEntry: null };
  }

  private recoverCommand(branchName: string, ref: string): string {
    return `git -C ${this.gitService.getBareRepoPath()} branch ${branchName}-recovered ${ref}`;
  }

  private async writeDivergedInfoFile(
    infoDir: string,
    originalPath: string,
    branchName: string,
    localCommit: string | null,
    keepRef: string | null = null,
    trashId: string | null = null,
  ): Promise<void> {
    const recoverRef = keepRef ?? localCommit;
    const metadata = {
      originalBranch: branchName,
      divergedAt: new Date().toISOString(),
      reason: METADATA_CONSTANTS.DIVERGED_REASON,
      originalPath,
      localCommit,
      remoteCommit: await this.gitService.getRemoteCommit(`origin/${branchName}`),
      keepRef,
      trashId,
      instruction: `This copy is detached from git: do not run git inside it.
  1. Recover the commits: ${recoverRef ? this.recoverCommand(branchName, recoverRef) : "no commit was recorded"}
  2. ${
    trashId
      ? `Get the files back: sync-worktrees trash restore ${trashId} (remove the replacement worktree and its branch first)`
      : "Get the files back: copy what you need out of this directory"
  }
  3. Discard changes: ${
    keepRef
      ? "use the TUI worktree status view so the keep ref is released safely"
      : `the files age out with the trash retention window; the commit is then kept by 'keep/${trashId}' until 'sync-worktrees trash drop-keep-ref ${trashId}'`
  }

  Original worktree location: ${originalPath}`,
    };

    await fs.writeFile(path.join(infoDir, METADATA_CONSTANTS.DIVERGED_INFO_FILE), JSON.stringify(metadata, null, 2));
  }
}
