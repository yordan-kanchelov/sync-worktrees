import * as fs from "fs/promises";
import * as path from "path";

import pLimit from "p-limit";

import { DEFAULT_CONFIG, ERROR_MESSAGES, GIT_CONSTANTS, METADATA_CONSTANTS } from "../constants";
import { filterBranchesByName } from "../utils/branch-filter";
import { filterBranchesByAge, formatDuration } from "../utils/date-filter";
import { getErrorMessage, isLfsError } from "../utils/lfs-error";
import { retry } from "../utils/retry";
import { PhaseTimer, Timer, formatTimingTable } from "../utils/timing";

import { GitService } from "./git.service";
import { Logger } from "./logger.service";
import { PathResolutionService } from "./path-resolution.service";

import type { Config } from "../types";
import type { WorktreeStatusDetails } from "./worktree-status.service";
import type { RetryOptions } from "../utils/retry";

export class WorktreeSyncService {
  private gitService: GitService;
  private logger: Logger;
  private syncInProgress: boolean = false;
  private pathResolution = new PathResolutionService();

  constructor(public readonly config: Config) {
    this.logger = config.logger ?? Logger.createDefault(undefined, config.debug);
    this.gitService = new GitService(config, this.logger);
  }

  async initialize(): Promise<void> {
    await this.gitService.initialize();
  }

  isInitialized(): boolean {
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
  }

  async sync(): Promise<void> {
    if (this.syncInProgress) {
      this.logger.warn("⚠️  Sync already in progress, skipping...");
      return;
    }
    this.syncInProgress = true;
    this.logger.info(`[${new Date().toISOString()}] Starting worktree synchronization...`);

    const totalTimer = new Timer();
    const phaseTimer = new PhaseTimer();
    const syncContext = { lfsSkipEnabled: false };
    const retryOptions = this.createRetryOptions(syncContext);

    try {
      await retry(() => this.runSyncAttempt(phaseTimer, syncContext), retryOptions);
    } catch (error) {
      this.logger.error("\n❌ Error during worktree synchronization after all retry attempts:", error);
      throw error;
    } finally {
      if (syncContext.lfsSkipEnabled && !this.config.skipLfs) {
        this.gitService.setLfsSkipEnabled(false);
      }
      this.syncInProgress = false;
      this.logger.info(`[${new Date().toISOString()}] Synchronization finished.\n`);

      if (this.config.debug) {
        const totalDuration = totalTimer.stop();
        const phaseResults = phaseTimer.getResults();
        const repoName = (this.config as { name?: string }).name;
        this.logger.table(formatTimingTable(totalDuration, phaseResults, repoName));
      }
    }
  }

  private createRetryOptions(syncContext: { lfsSkipEnabled: boolean }): RetryOptions {
    return {
      maxAttempts: this.config.retry?.maxAttempts ?? 3,
      maxLfsRetries: this.config.retry?.maxLfsRetries ?? 2,
      initialDelayMs: this.config.retry?.initialDelayMs ?? 1000,
      maxDelayMs: this.config.retry?.maxDelayMs ?? 30000,
      backoffMultiplier: this.config.retry?.backoffMultiplier ?? 2,
      onRetry: (error, attempt, context): void => {
        const errorMessage = getErrorMessage(error);
        this.logger.info(`\n⚠️  Sync attempt ${attempt} failed: ${errorMessage}`);

        if (context?.isLfsError && !this.config.skipLfs) {
          this.logger.info(`🔄 LFS error detected. Will retry with LFS skipped...`);
        } else {
          this.logger.info(`🔄 Retrying synchronization...\n`);
        }
      },
      lfsRetryHandler: (): void => {
        if (!this.config.skipLfs && !syncContext.lfsSkipEnabled) {
          this.logger.info("⚠️  Temporarily disabling LFS downloads for this sync...");
          this.gitService.setLfsSkipEnabled(true);
          syncContext.lfsSkipEnabled = true;
        }
      },
    };
  }

  private async runSyncAttempt(phaseTimer: PhaseTimer, syncContext: { lfsSkipEnabled: boolean }): Promise<void> {
    await this.gitService.pruneWorktrees();
    await this.fetchLatestRemoteData(phaseTimer, syncContext);

    const { remoteBranches, defaultBranch } = await this.resolveSyncBranches();

    await fs.mkdir(this.config.worktreeDir, { recursive: true });

    const worktrees = await this.gitService.getWorktrees();
    this.logger.info(`Found ${worktrees.length} existing Git worktrees.`);

    await this.cleanupOrphanedDirectories(worktrees);
    await this.createNewWorktreesWithTiming(remoteBranches, worktrees, defaultBranch, phaseTimer);
    await this.pruneOldWorktreesWithTiming(remoteBranches, worktrees, phaseTimer);

    if (this.config.updateExistingWorktrees !== false) {
      await this.updateExistingWorktreesWithTiming(worktrees, remoteBranches, phaseTimer);
    }

    await this.finalizeSyncAttempt(phaseTimer);
  }

  private async fetchLatestRemoteData(phaseTimer: PhaseTimer, syncContext: { lfsSkipEnabled: boolean }): Promise<void> {
    this.logger.info("Step 1: Fetching latest data from remote...");
    phaseTimer.startPhase("Phase 1: Fetch");

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
    await this.gitService.pruneWorktrees();
    this.logger.info("Step 5: Pruned worktree metadata.");
    phaseTimer.endPhase();
  }

  private async createNewWorktreesWithTiming(
    remoteBranches: string[],
    worktrees: Array<{ path: string; branch: string }>,
    defaultBranch: string,
    phaseTimer: PhaseTimer,
  ): Promise<void> {
    const maxConcurrent =
      this.config.parallelism?.maxWorktreeCreation ?? DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_CREATION;
    phaseTimer.startPhase("Phase 2: Create", maxConcurrent);

    await this.createNewWorktrees(remoteBranches, worktrees, defaultBranch);

    const existingBranches = new Set(worktrees.map((w) => w.branch));
    const newBranches = remoteBranches.filter((b) => !existingBranches.has(b) && b !== defaultBranch);
    phaseTimer.setPhaseCount("Phase 2: Create", newBranches.length);
    phaseTimer.endPhase();
  }

  private async createNewWorktrees(
    remoteBranches: string[],
    worktrees: Array<{ path: string; branch: string }>,
    defaultBranch: string,
  ): Promise<void> {
    const existingBranches = new Set(worktrees.map((w) => w.branch));
    const newBranches = remoteBranches.filter((b) => !existingBranches.has(b) && b !== defaultBranch);

    if (newBranches.length === 0) {
      this.logger.info("Step 2: No new branches to create worktrees for.");
      return;
    }

    const reservedPaths = new Map<string, string>();
    for (const w of worktrees) {
      reservedPaths.set(path.resolve(w.path), w.branch);
    }

    const plan: Array<{ branchName: string; worktreePath: string }> = [];
    for (const branchName of newBranches) {
      const worktreePath = this.pathResolution.getBranchWorktreePath(this.config.worktreeDir, branchName);
      const resolved = path.resolve(worktreePath);
      const conflict = reservedPaths.get(resolved);
      if (conflict && conflict !== branchName) {
        this.logger.error(
          `  ❌ Skipping '${branchName}': sanitized worktree path '${worktreePath}' collides with existing branch '${conflict}'.`,
        );
        continue;
      }
      reservedPaths.set(resolved, branchName);
      plan.push({ branchName, worktreePath });
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
          } catch (error) {
            this.logger.error(`  ❌ Failed to create worktree for '${branchName}':`, getErrorMessage(error));
            throw error;
          }
        }),
      ),
    );

    const successCount = results.filter((r) => r.status === "fulfilled").length;
    this.logger.info(`  Created ${successCount}/${plan.length} worktrees successfully`);
  }

  private async pruneOldWorktreesWithTiming(
    remoteBranches: string[],
    worktrees: Array<{ path: string; branch: string }>,
    phaseTimer: PhaseTimer,
  ): Promise<void> {
    const maxConcurrent = this.config.parallelism?.maxStatusChecks ?? DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS;
    phaseTimer.startPhase("Phase 3: Prune", maxConcurrent);

    await this.pruneOldWorktrees(remoteBranches, worktrees);

    const deletedWorktrees = worktrees.filter((w) => !remoteBranches.includes(w.branch));
    phaseTimer.setPhaseCount("Phase 3: Prune", deletedWorktrees.length);
    phaseTimer.endPhase();
  }

  private async pruneOldWorktrees(
    remoteBranches: string[],
    worktrees: Array<{ path: string; branch: string }>,
  ): Promise<void> {
    const deletedWorktrees = worktrees.filter((w) => !remoteBranches.includes(w.branch));

    if (deletedWorktrees.length > 0) {
      this.logger.info(`Step 3: Checking ${deletedWorktrees.length} stale worktrees to prune...`);

      // Two-phase approach: First check status in parallel (read-only, safe),
      // then remove worktrees in parallel (mutation, needs lower concurrency)
      const maxConcurrent = this.config.parallelism?.maxStatusChecks ?? DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS;
      const limit = pLimit(maxConcurrent);

      const statusResults = await Promise.allSettled(
        deletedWorktrees.map(({ branch: branchName, path: worktreePath }) =>
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
            toRemove.push({ branchName, worktreePath });
          } else {
            toSkip.push({ branchName, worktreePath, status });
          }
        } else {
          const branchName = (result.reason as Error & { branchName?: string })?.branchName ?? "unknown";
          this.logger.error(`  - Error checking worktree '${branchName}':`, result.reason);
          this.logger.warn(`  - ⚠️ Skipping removal of '${branchName}' due to status check failure (conservative)`);
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
                // Re-validate status immediately before removal to close TOCTOU window
                const recheck = await this.gitService.getFullWorktreeStatus(worktreePath, false);
                if (!recheck.canRemove) {
                  this.logger.warn(
                    `  ⚠️ Skipping removal of '${branchName}' - status changed since initial check: ${recheck.reasons.join(", ")}`,
                  );
                  return;
                }
                await this.gitService.removeWorktree(worktreePath);
                this.logger.info(`  ✅ Removed worktree for '${branchName}'`);
              } catch (error) {
                this.logger.error(`  ❌ Failed to remove worktree for '${branchName}':`, getErrorMessage(error));
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

    const fetchLimit = pLimit(3);
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
    worktrees: { path: string; branch: string }[],
    remoteBranches: string[],
    phaseTimer: PhaseTimer,
  ): Promise<void> {
    const maxConcurrent =
      this.config.parallelism?.maxWorktreeUpdates ?? DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_UPDATES;
    phaseTimer.startPhase("Phase 4: Update", maxConcurrent);

    await this.updateExistingWorktrees(worktrees, remoteBranches);

    const activeWorktrees = worktrees.filter((w) => remoteBranches.includes(w.branch));
    phaseTimer.setPhaseCount("Phase 4: Update", activeWorktrees.length);
    phaseTimer.endPhase();
  }

  private async updateExistingWorktrees(
    worktrees: { path: string; branch: string }[],
    remoteBranches: string[],
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
      // No diverged directory, that's fine
    }

    const activeWorktrees = worktrees.filter((w) => remoteBranches.includes(w.branch));

    type UpdateCheckResult = { action: "update" | "diverged"; worktree: { path: string; branch: string } } | null;

    // Phase 4a: Check which worktrees need updates (parallel, read-only, high concurrency)
    const maxConcurrent = this.config.parallelism?.maxStatusChecks ?? DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS;
    const limit = pLimit(maxConcurrent);

    const checkResults = await Promise.allSettled(
      activeWorktrees.map((worktree) =>
        limit(async (): Promise<UpdateCheckResult> => {
          try {
            await fs.access(worktree.path);
          } catch {
            return null;
          }

          const hasOp = await this.gitService.hasOperationInProgress(worktree.path);
          if (hasOp) return null;

          const isClean = await this.gitService.checkWorktreeStatus(worktree.path);
          if (!isClean) return null;

          const canFastForward = await this.gitService.canFastForward(worktree.path, worktree.branch);
          if (!canFastForward) {
            const isAhead = await this.gitService.isLocalAheadOfRemote(worktree.path, worktree.branch);
            if (isAhead) {
              this.logger.info(`⏭️  Skipping '${worktree.branch}' - has unpushed commits`);
              return null;
            }
            return { action: "diverged", worktree };
          }

          const isBehind = await this.gitService.isWorktreeBehind(worktree.path);
          return isBehind ? { action: "update", worktree } : null;
        }),
      ),
    );

    const worktreesToUpdate: { path: string; branch: string }[] = [];
    const divergedWorktrees: { path: string; branch: string }[] = [];

    for (const result of checkResults) {
      if (result.status === "fulfilled" && result.value) {
        if (result.value.action === "update") {
          worktreesToUpdate.push(result.value.worktree);
        } else {
          divergedWorktrees.push(result.value.worktree);
        }
      } else if (result.status === "rejected") {
        this.logger.error(`  - Error checking worktree:`, result.reason);
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
          } catch (error) {
            const errorMessage = getErrorMessage(error);

            if (ERROR_MESSAGES.FAST_FORWARD_FAILED.some((msg) => errorMessage.includes(msg))) {
              this.logger.info(
                `    ⚠️ Branch '${worktree.branch}' cannot be fast-forwarded. Checking for divergence...`,
              );
              try {
                await this.handleDivergedBranch(worktree);
              } catch (divergedError) {
                this.logger.error(`    ❌ Failed to handle diverged branch '${worktree.branch}':`, divergedError);
              }
            } else {
              this.logger.error(`    ❌ Failed to update '${worktree.branch}':`, error);
            }
            throw error;
          }
          return { type: "update" as const, branch: worktree.branch };
        }),
      );
    }

    for (const worktree of divergedWorktrees) {
      mutationTasks.push(
        updateLimit(async () => {
          try {
            await this.handleDivergedBranch(worktree);
          } catch (error) {
            this.logger.error(`    ❌ Failed to handle diverged branch '${worktree.branch}':`, error);
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

      // Filter out special directories like .diverged
      const regularDirs = allDirs.filter((dir) => !dir.startsWith("."));

      // For each directory, check if it's part of any worktree path
      const orphanedDirs: string[] = [];
      for (const dir of regularDirs) {
        // Check if this directory is part of any worktree path
        const isPartOfWorktree = worktreeRelativePaths.some((worktreePath) => {
          // Either the directory IS a worktree or it's a parent of a worktree
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
            const stat = await fs.stat(dirPath);
            if (stat.isDirectory()) {
              await fs.rm(dirPath, { recursive: true, force: true });
              this.logger.info(`  - Removed orphaned directory: ${dir}`);
            }
          } catch (error) {
            this.logger.error(`  - Failed to remove orphaned directory ${dir}:`, error);
          }
        }
      }
    } catch (error) {
      this.logger.error("Error during orphaned directory cleanup:", error);
    }
  }

  private async handleDivergedBranch(worktree: { path: string; branch: string }): Promise<void> {
    this.logger.info(`⚠️  Branch '${worktree.branch}' has diverged from upstream. Analyzing...`);

    const treesIdentical = await this.gitService.compareTreeContent(worktree.path, worktree.branch);

    if (treesIdentical) {
      this.logger.info(`✅ Branch '${worktree.branch}' was rebased but files are identical. Resetting to upstream...`);
      await this.gitService.resetToUpstream(worktree.path, worktree.branch);
      this.logger.info(`   Successfully updated '${worktree.branch}' to match upstream.`);
    } else {
      const hasLocalChanges = await this.hasLocalChangesSinceLastSync(worktree.path);

      if (!hasLocalChanges) {
        this.logger.info(
          `✅ Branch '${worktree.branch}' has diverged but you made no local changes. Resetting to upstream...`,
        );
        await this.gitService.resetToUpstream(worktree.path, worktree.branch);
        this.logger.info(`   Successfully updated '${worktree.branch}' to match upstream.`);
      } else {
        this.logger.info(`🔒 Branch '${worktree.branch}' has diverged with local changes. Moving to diverged...`);

        const divergedPath = await this.divergeWorktree(worktree.path, worktree.branch);
        const relativePath = path.relative(process.cwd(), divergedPath);

        this.logger.info(`   Moved to: ${relativePath}`);
        this.logger.info(`   Your local changes are preserved. To review:`);
        this.logger.info(`     cd ${relativePath}`);
        this.logger.info(`     git diff origin/${worktree.branch}`);

        await this.gitService.removeWorktree(worktree.path);
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

  private async divergeWorktree(worktreePath: string, branchName: string): Promise<string> {
    // Create .diverged directory inside worktreeDir
    const divergedBaseDir = path.join(this.config.worktreeDir, GIT_CONSTANTS.DIVERGED_DIR_NAME);

    const timestamp = new Date().toISOString().split("T")[0];
    const uniqueSuffix = Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
    const safeBranchName = branchName.replace(/\//g, "-");
    const divergedName = `${timestamp}-${safeBranchName}-${uniqueSuffix}`;
    const divergedPath = path.join(divergedBaseDir, divergedName);

    // Ensure diverged directory exists
    await fs.mkdir(divergedBaseDir, { recursive: true });

    // Move the worktree directory; on cross-device errors, fall back to copy+remove
    try {
      await fs.rename(worktreePath, divergedPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("EXDEV")) {
        // Cross-device link not permitted: copy then remove
        await fs.cp(worktreePath, divergedPath, { recursive: true });
        await fs.rm(worktreePath, { recursive: true, force: true });
      } else {
        throw err;
      }
    }

    // Save metadata about why it was moved
    const metadata = {
      originalBranch: branchName,
      divergedAt: new Date().toISOString(),
      reason: METADATA_CONSTANTS.DIVERGED_REASON,
      originalPath: worktreePath,
      localCommit: await this.gitService.getCurrentCommit(divergedPath),
      remoteCommit: await this.gitService.getRemoteCommit(`origin/${branchName}`),
      instruction: `To preserve your changes:
  1. Review: git diff origin/${branchName}
  2. Keep changes: git push --force-with-lease origin ${branchName}
  3. Discard changes: rm -rf this directory

  Original worktree location: ${worktreePath}`,
    };

    await fs.writeFile(
      path.join(divergedPath, METADATA_CONSTANTS.DIVERGED_INFO_FILE),
      JSON.stringify(metadata, null, 2),
    );

    return divergedPath;
  }
}
