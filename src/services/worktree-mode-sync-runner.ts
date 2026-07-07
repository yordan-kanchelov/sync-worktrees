import * as fs from "fs/promises";
import * as path from "path";

import pLimit from "p-limit";

import { DEFAULT_CONFIG, ERROR_MESSAGES, GIT_CONSTANTS, METADATA_CONSTANTS, PATH_CONSTANTS } from "../constants";
import { TrashOperationError, WorktreeNotCleanError } from "../errors";
import { filterBranchesByName } from "../utils/branch-filter";
import { filterBranchesByAge, formatDuration } from "../utils/date-filter";
import { probePathExists } from "../utils/file-exists";
import { getErrorMessage, isLfsError } from "../utils/lfs-error";
import { getRemovalAuditLogPath } from "../utils/lock-path";
import { normalizePathForCompare } from "../utils/path-compare";
import { quarantineDirectory } from "../utils/quarantine";

import { PathResolutionService } from "./path-resolution.service";
import { RemovalAuditService } from "./removal-audit.service";
import { TrashService } from "./trash.service";
import { createWorktreeSyncPlan } from "./worktree-sync-planner";

import type { GitService } from "./git.service";
import type { Logger } from "./logger.service";
import type { ProgressEmitter } from "./progress-emitter";
import type { SyncOutcomeAccumulator } from "./sync-outcome";
import type { SyncRetryContext } from "./sync-retry-policy";
import type { TrashManifest } from "./trash.service";
import type { WorktreeStatusDetails, WorktreeStatusResult } from "./worktree-status.service";
import type { CreateAction, PruneAction, SparseAction, SyncPlan, UpdateAction } from "./worktree-sync-planner";
import type { Config } from "../types";
import type { PhaseTimer } from "../utils/timing";

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
    await this.gitService.pruneWorktrees();
    await this.fetchLatestRemoteData(phaseTimer, syncContext);

    const { remoteBranches, defaultBranch } = await this.resolveSyncBranches();

    await fs.mkdir(this.config.worktreeDir, { recursive: true });

    const worktrees = await this.gitService.getWorktrees();
    this.logger.info(`Found ${worktrees.length} existing Git worktrees.`);

    await this.cleanupOrphanedDirectories(worktrees);
    const syncPlan = createWorktreeSyncPlan(
      {
        remoteBranches,
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

    await this.createNewWorktreesWithTiming(syncPlan, phaseTimer, outcome);
    await this.recordRemoteBranchTips([...worktrees, ...syncPlan.create.filter((action) => action.kind === "create")]);
    await this.pruneOldWorktreesWithTiming(syncPlan.prune, phaseTimer, outcome);

    if (this.config.updateExistingWorktrees !== false) {
      await this.updateExistingWorktreesWithTiming(syncPlan.update, phaseTimer, outcome);
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

  private async resolveSyncBranches(): Promise<{ remoteBranches: string[]; defaultBranch: string }> {
    const remoteBranches = this.config.branchMaxAge
      ? await this.getRemoteBranchesFilteredByActivity()
      : await this.getRemoteBranchesFilteredByName();
    const defaultBranch = this.gitService.getDefaultBranch();

    if (!remoteBranches.includes(defaultBranch)) {
      remoteBranches.push(defaultBranch);
      this.logger.info(`Ensuring default branch '${defaultBranch}' is retained.`);
    }

    return { remoteBranches, defaultBranch };
  }

  private async getRemoteBranchesFilteredByActivity(): Promise<string[]> {
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

    return remoteBranches;
  }

  private async getRemoteBranchesFilteredByName(): Promise<string[]> {
    const allBranches = await this.gitService.getRemoteBranches();
    this.logger.info(`Found ${allBranches.length} remote branches.`);

    const remoteBranches = filterBranchesByName(allBranches, this.config.branchInclude, this.config.branchExclude);

    if (remoteBranches.length < allBranches.length) {
      this.logger.info(`After branch name filtering: ${remoteBranches.length} of ${allBranches.length} branches.`);
    }

    return remoteBranches;
  }

  private async finalizeSyncAttempt(phaseTimer: PhaseTimer): Promise<void> {
    phaseTimer.startPhase("Phase 5: Cleanup");
    this.progressEmitter.emit({ phase: "cleanup", message: "Pruning worktree metadata" });
    await this.gitService.pruneWorktrees();
    this.logger.info("Step 5: Pruned worktree metadata.");
    phaseTimer.endPhase();
  }

  private async createNewWorktreesWithTiming(
    syncPlan: SyncPlan,
    phaseTimer: PhaseTimer,
    outcome: SyncOutcomeAccumulator,
  ): Promise<void> {
    phaseTimer.startPhase("Phase 2: Create");
    this.progressEmitter.emit({ phase: "create", message: "Creating worktrees for new branches" });

    await this.createNewWorktrees(syncPlan.create, outcome);

    phaseTimer.setPhaseCount("Phase 2: Create", syncPlan.create.length);
    phaseTimer.endPhase();
  }

  private async createNewWorktrees(actions: CreateAction[], outcome: SyncOutcomeAccumulator): Promise<void> {
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
          try {
            await this.gitService.addWorktree(branchName, worktreePath);
            this.logger.info(`  ✅ Created worktree for '${branchName}'`);
            outcome.recordCreated(branchName, worktreePath);
          } catch (error) {
            this.logger.error(`  ❌ Failed to create worktree for '${branchName}':`, getErrorMessage(error));
            outcome.recordFailed("worktree", getErrorMessage(error), {
              reason: "create_failed",
              branch: branchName,
              path: worktreePath,
            });
            throw error;
          }
        }),
      ),
    );

    const successCount = results.filter((r) => r.status === "fulfilled").length;
    this.logger.info(`  Created ${successCount}/${plan.length} worktrees successfully`);
  }

  // Persist each worktree's upstream tip while the remote ref still exists.
  // This is the proof consulted after a squash-merge deletes the branch:
  // "HEAD was on the remote before the deletion" — without it every such
  // worktree reads as having unpushed commits forever. Best-effort: a failed
  // recording only means that worktree stays conservatively preserved.
  private async recordRemoteBranchTips(worktrees: Array<{ path: string; branch: string }>): Promise<void> {
    try {
      const tips = await this.gitService.getRemoteBranchTips();
      if (tips.size === 0) return;

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
    } catch (error) {
      this.logger.warn(`⚠️ Could not record remote branch tips: ${getErrorMessage(error)}`);
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
    if (actions.length > 0) {
      this.logger.info(`Step 3: Checking ${actions.length} stale worktrees to prune...`);

      // Two-phase approach: First check status in parallel (read-only, safe),
      // then remove worktrees in parallel (mutation, needs lower concurrency)
      const maxConcurrent = this.config.parallelism?.maxStatusChecks ?? DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS;
      const limit = pLimit(maxConcurrent);

      const statusResults = await Promise.allSettled(
        actions.map(({ branch: branchName, path: worktreePath }) =>
          limit(async () => {
            const status = await this.gitService.getFullWorktreeStatus(worktreePath, this.config.debug);
            return { branchName, worktreePath, status };
          }).catch((error) => {
            throw Object.assign(error instanceof Error ? error : new Error(String(error)), { branchName });
          }),
        ),
      );

      const toRemove: Array<{ branchName: string; worktreePath: string }> = [];
      const toSkip: Array<{
        branchName: string;
        worktreePath: string;
        status: Awaited<ReturnType<GitService["getFullWorktreeStatus"]>>;
      }> = [];

      for (const result of statusResults) {
        if (result.status === "fulfilled") {
          const { branchName, worktreePath, status } = result.value;
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
          const branchName = (result.reason as Error & { branchName?: string })?.branchName ?? "unknown";
          this.logger.error(`  - Error checking worktree '${branchName}':`, result.reason);
          this.logger.warn(`  - ⚠️ Skipping removal of '${branchName}' due to status check failure (conservative)`);
          outcome.recordSkipped("worktree", "prune_status_check_failed", {
            branch: branchName,
            message: getErrorMessage(result.reason),
          });
        }
      }

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
                  return;
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
                  return;
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
                  return;
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
              } catch (error) {
                if (error instanceof WorktreeNotCleanError) {
                  this.logger.warn(`  ⚠️ Skipping removal of '${branchName}' - git refused: ${getErrorMessage(error)}`);
                  outcome.recordSkipped("worktree", "git_refused_removal", {
                    branch: branchName,
                    path: worktreePath,
                    message: getErrorMessage(error),
                  });
                  return;
                }
                if (error instanceof TrashOperationError) {
                  this.logger.warn(`  ⚠️ Skipping removal of '${branchName}' - ${getErrorMessage(error)}`);
                  outcome.recordSkipped("worktree", "trash_failed", {
                    branch: branchName,
                    path: worktreePath,
                    message: getErrorMessage(error),
                  });
                  return;
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

        const removedCount = removeResults.filter((r) => r.status === "fulfilled").length;
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
    } else {
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
    outcome: SyncOutcomeAccumulator,
  ): Promise<void> {
    phaseTimer.startPhase("Phase 4: Update");
    this.progressEmitter.emit({ phase: "update", message: "Updating existing worktrees" });

    await this.updateExistingWorktrees(actions, outcome);

    phaseTimer.setPhaseCount("Phase 4: Update", actions.length);
    phaseTimer.endPhase();
  }

  private async updateExistingWorktrees(actions: UpdateAction[], outcome: SyncOutcomeAccumulator): Promise<void> {
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

          const isClean = await this.gitService.checkWorktreeStatus(worktree.path);
          if (!isClean) return { action: "skip", worktree, reason: "dirty_worktree" };

          const canFastForward = await this.gitService.canFastForward(worktree.path, worktree.branch);
          if (!canFastForward) {
            const isAhead = await this.gitService.isLocalAheadOfRemote(worktree.path, worktree.branch);
            if (isAhead) {
              this.logger.info(`⏭️  Skipping '${worktree.branch}' - has unpushed commits`);
              return { action: "skip", worktree, reason: "local_ahead" };
            }
            return { action: "diverged", worktree };
          }

          const isBehind = await this.gitService.isWorktreeBehind(worktree.path);
          if (!isBehind) return { action: "noop", worktree, reason: "already_up_to_date" };

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

    for (const result of checkResults) {
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
        // Probe-only failure (status / fast-forward / divergence check threw). The
        // actual update is gated on success here, so a probe error means we never
        // touched the worktree — treat it as a skip, not a hard failure.
        this.logger.error(`  - Error checking worktree:`, result.reason);
        outcome.recordSkipped("worktree", "update_check_failed", {
          message: getErrorMessage(result.reason),
        });
      }
    }

    // Phase 4b: Perform mutations (updates + diverged handling) with lower concurrency
    const updateLimit = pLimit(
      this.config.parallelism?.maxWorktreeUpdates ?? DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_UPDATES,
    );

    const mutationTasks: Promise<{ type: "update" | "diverged"; branch: string }>[] = [];

    for (const worktree of worktreesToUpdate) {
      mutationTasks.push(
        updateLimit(async () => {
          try {
            this.logger.info(`  - Updating worktree '${worktree.branch}'...`);
            await this.gitService.updateWorktree(worktree.path);
            this.logger.info(`    ✅ Successfully updated '${worktree.branch}'.`);
            outcome.recordUpdated(worktree.branch, worktree.path, "fast_forward");
          } catch (error) {
            const errorMessage = getErrorMessage(error);

            if (ERROR_MESSAGES.FAST_FORWARD_FAILED.some((msg) => errorMessage.includes(msg))) {
              this.logger.info(
                `    ⚠️ Branch '${worktree.branch}' cannot be fast-forwarded. Checking for divergence...`,
              );
              try {
                await this.handleDivergedBranch(worktree, outcome);
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
          return { type: "update" as const, branch: worktree.branch };
        }),
      );
    }

    for (const worktree of divergedWorktrees) {
      mutationTasks.push(
        updateLimit(async () => {
          try {
            await this.handleDivergedBranch(worktree, outcome);
          } catch (error) {
            this.logger.error(`    ❌ Failed to handle diverged branch '${worktree.branch}':`, error);
            outcome.recordFailed("worktree", getErrorMessage(error), {
              reason: "diverged_recovery_failed",
              branch: worktree.branch,
              path: worktree.path,
            });
            throw error;
          }
          return { type: "diverged" as const, branch: worktree.branch };
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

      const successCount = mutationResults.filter((r) => r.status === "fulfilled").length;
      this.logger.info(`  Processed ${successCount}/${mutationTasks.length} worktrees successfully`);
    } else {
      this.logger.info("  - All worktrees are up to date.");
    }
  }

  private async cleanupOrphanedDirectories(worktrees: { path: string; branch: string }[]): Promise<void> {
    try {
      const worktreeRelativePaths = worktrees.map((w) => path.relative(this.config.worktreeDir, w.path));
      const allDirs = await fs.readdir(this.config.worktreeDir);

      // Filter out special directories like .diverged.
      const regularDirs = allDirs.filter((dir) => !dir.startsWith("."));

      const orphanedDirs: string[] = [];
      for (const dir of regularDirs) {
        const isPartOfWorktree = worktreeRelativePaths.some((worktreePath) => {
          return worktreePath === dir || worktreePath.startsWith(dir + path.sep);
        });

        if (!isPartOfWorktree) {
          orphanedDirs.push(dir);
        }
      }

      if (orphanedDirs.length > 0) {
        this.logger.info(`Found ${orphanedDirs.length} orphaned directories: ${orphanedDirs.join(", ")}`);

        for (const dir of orphanedDirs) {
          const dirPath = path.join(this.config.worktreeDir, dir);
          try {
            if (normalizePathForCompare(dirPath) === normalizePathForCompare(this.gitService.getBareRepoPath())) {
              this.logger.warn(`  - ⚠️ Skipping orphaned directory ${dir}: matches configured bareRepoDir`);
              continue;
            }

            const stat = await fs.stat(dirPath);
            if (!stat.isDirectory()) {
              continue;
            }

            // An "orphan" containing a .git may be a live checkout that git
            // failed to report (corrupt admin dir, transient list error) —
            // quarantine it instead of deleting.
            const gitProbe = await probePathExists(path.join(dirPath, PATH_CONSTANTS.GIT_DIR));
            if (gitProbe === "unknown") {
              this.logger.warn(`  - ⚠️ Skipping orphaned directory ${dir}: cannot verify it is not a live checkout`);
              continue;
            }

            if (this.trashService.isEnabled()) {
              try {
                const entry = await this.trashService.trashDirectory({ dirPath, reason: "orphan" });
                this.logger.info(`  - Moved orphaned directory '${dir}' to trash (id: ${entry.manifest.id})`);
              } catch (trashError) {
                this.logger.warn(`  - ⚠️ Skipping orphaned directory ${dir} - ${getErrorMessage(trashError)}`);
              }
              continue;
            }

            if (gitProbe === "exists") {
              const quarantinePath = await quarantineDirectory(dirPath);
              this.logger.warn(
                `  - ⚠️ Orphaned directory ${dir} contains a .git; quarantined to '${quarantinePath}' instead of deleting.`,
              );
              await this.removalAudit
                .record({ action: "orphan_quarantine", result: "success", path: dirPath, quarantinePath })
                .catch((auditError: unknown) =>
                  this.logger.warn(`  ⚠️ Failed to write removal audit record: ${getErrorMessage(auditError)}`),
                );
              continue;
            }

            try {
              await this.removalAudit.record({ action: "orphan_delete", result: "attempt", path: dirPath });
            } catch (auditError) {
              this.logger.warn(
                `  - ⚠️ Skipping orphaned directory ${dir} - cannot write removal audit log: ${getErrorMessage(auditError)}`,
              );
              continue;
            }
            await fs.rm(dirPath, { recursive: true, force: true });
            this.logger.info(`  - Removed orphaned directory: ${dir}`);
          } catch (error) {
            this.logger.error(`  - Failed to remove orphaned directory ${dir}:`, error);
          }
        }
      }
    } catch (error) {
      this.logger.error("Error during orphaned directory cleanup:", error);
    }
  }

  private async handleDivergedBranch(
    worktree: { path: string; branch: string },
    outcome: SyncOutcomeAccumulator,
  ): Promise<void> {
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
      return;
    }

    const treesIdentical = await this.gitService.compareTreeContent(worktree.path, worktree.branch);

    if (treesIdentical) {
      this.logger.info(`✅ Branch '${worktree.branch}' was rebased but files are identical. Resetting to upstream...`);
      await this.gitService.resetToUpstream(worktree.path, worktree.branch);
      this.logger.info(`   Successfully updated '${worktree.branch}' to match upstream.`);
      outcome.recordUpdated(worktree.branch, worktree.path, "reset_identical_tree");
    } else {
      const hasLocalChanges = await this.hasLocalChangesSinceLastSync(worktree.path);

      if (!hasLocalChanges) {
        this.logger.info(
          `✅ Branch '${worktree.branch}' has diverged but you made no local changes. Resetting to upstream...`,
        );
        await this.gitService.resetToUpstream(worktree.path, worktree.branch);
        this.logger.info(`   Successfully updated '${worktree.branch}' to match upstream.`);
        outcome.recordUpdated(worktree.branch, worktree.path, "reset_no_local_changes");
      } else {
        this.logger.info(`🔒 Branch '${worktree.branch}' has diverged with local changes. Moving to diverged...`);

        // With trash disabled there is no pin ref, yet the local branch ref
        // must still be deleted below (or addWorktree would recreate the
        // worktree from the stale branch instead of upstream). A permanent
        // keep ref preserves the never-pushed commits first; failure aborts
        // while the worktree is still intact.
        let keepRef: string | null = null;
        if (!this.trashService.isEnabled()) {
          const localCommit = (await this.gitService.getCurrentCommit(worktree.path)).trim();
          keepRef = `${GIT_CONSTANTS.KEEP_REF_PREFIX}diverged-${Date.now().toString(36)}-${this.pathResolution.sanitizeBranchName(worktree.branch)}`;
          await this.gitService.updateRef(keepRef, localCommit);
        }

        const { divergedPath, manifest } = await this.divergeWorktree(worktree.path, worktree.branch);
        const relativePath = path.relative(process.cwd(), divergedPath);
        outcome.recordPreservedDiverged(worktree.branch, worktree.path, divergedPath);

        this.logger.info(`   Moved to: ${relativePath}`);
        this.logger.info(`   Your local changes are preserved. To review:`);
        this.logger.info(`     cd ${relativePath}`);
        this.logger.info(`     git diff origin/${worktree.branch}`);

        // force is safe here: the directory was already moved to .diverged/,
        // so only the stale registration is being cleared.
        await this.gitService.removeWorktree(worktree.path, { force: true });
        // Deliberately fatal on failure (unlike prune): addWorktree below
        // would silently recreate the worktree from the stale local branch
        // instead of upstream if the ref survived.
        if (manifest !== null) {
          await this.trashService.deleteTrashedBranchRef(manifest);
        } else {
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
        await this.gitService.addWorktree(worktree.branch, worktree.path);
        this.logger.info(`   Created fresh worktree from upstream at: ${worktree.path}`);
      }
    }
  }

  private async hasLocalChangesSinceLastSync(worktreePath: string): Promise<boolean> {
    try {
      const metadata = await this.gitService.getWorktreeMetadata(worktreePath);
      if (!metadata || !metadata.lastSyncCommit) {
        return true;
      }

      const currentCommit = await this.gitService.getCurrentCommit(worktreePath);
      return currentCommit !== metadata.lastSyncCommit;
    } catch {
      return true;
    }
  }

  private async divergeWorktree(
    worktreePath: string,
    branchName: string,
  ): Promise<{ divergedPath: string; manifest: TrashManifest | null }> {
    if (this.trashService.isEnabled()) {
      // keepPinOnReap: diverged-replace trashes the only copy of never-pushed
      // commits, so pin/bundle failure must abort while the worktree is intact.
      const entry = await this.trashService.trashDirectory({
        dirPath: worktreePath,
        branch: branchName,
        reason: "diverged-replace",
        keepPinOnReap: true,
      });
      await this.writeDivergedInfoFile(entry.payloadPath, worktreePath, branchName, entry.manifest.headOid);
      return { divergedPath: entry.payloadPath, manifest: entry.manifest };
    }

    const divergedBaseDir = path.join(this.config.worktreeDir, GIT_CONSTANTS.DIVERGED_DIR_NAME);

    const timestamp = new Date().toISOString().split("T")[0];
    const uniqueSuffix = Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
    const safeBranchName = this.pathResolution.sanitizeBranchName(branchName);
    const divergedName = `${timestamp}-${safeBranchName}-${uniqueSuffix}`;
    const divergedPath = path.join(divergedBaseDir, divergedName);

    await fs.mkdir(divergedBaseDir, { recursive: true });

    try {
      await fs.rename(worktreePath, divergedPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === ERROR_MESSAGES.EXDEV) {
        await fs.cp(worktreePath, divergedPath, { recursive: true });
        await fs.rm(worktreePath, { recursive: true, force: true });
      } else {
        throw err;
      }
    }

    await this.writeDivergedInfoFile(divergedPath, worktreePath, branchName, null);

    return { divergedPath, manifest: null };
  }

  private async writeDivergedInfoFile(
    preservedPath: string,
    originalPath: string,
    branchName: string,
    knownLocalCommit: string | null,
  ): Promise<void> {
    const metadata = {
      originalBranch: branchName,
      divergedAt: new Date().toISOString(),
      reason: METADATA_CONSTANTS.DIVERGED_REASON,
      originalPath,
      localCommit: knownLocalCommit ?? (await this.gitService.getCurrentCommit(preservedPath)),
      remoteCommit: await this.gitService.getRemoteCommit(`origin/${branchName}`),
      instruction: `To preserve your changes:
  1. Review: git diff origin/${branchName}
  2. Keep changes: git push --force-with-lease origin ${branchName}
  3. Discard changes: rm -rf this directory

  Original worktree location: ${originalPath}`,
    };

    await fs.writeFile(
      path.join(preservedPath, METADATA_CONSTANTS.DIVERGED_INFO_FILE),
      JSON.stringify(metadata, null, 2),
    );
  }
}
