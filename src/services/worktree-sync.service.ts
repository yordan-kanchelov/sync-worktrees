import * as fs from "fs/promises";
import * as path from "path";

import pLimit from "p-limit";

import { DEFAULT_CONFIG } from "../constants";
import { filterBranchesByAge, formatDuration } from "../utils/date-filter";
import { getErrorMessage, isLfsError } from "../utils/lfs-error";
import { retry } from "../utils/retry";

import { GitService } from "./git.service";

import type { Config } from "../types";
import type { WorktreeStatusDetails } from "./worktree-status.service";
import type { RetryOptions } from "../utils/retry";

export class WorktreeSyncService {
  private gitService: GitService;
  private syncInProgress: boolean = false;

  constructor(public readonly config: Config) {
    this.gitService = new GitService(config);
  }

  async initialize(): Promise<void> {
    await this.gitService.initialize();
  }

  isSyncInProgress(): boolean {
    return this.syncInProgress;
  }

  async sync(): Promise<void> {
    if (this.syncInProgress) {
      console.warn("⚠️  Sync already in progress, skipping...");
      return;
    }
    this.syncInProgress = true;
    console.log(`[${new Date().toISOString()}] Starting worktree synchronization...`);

    let lfsSkipEnabled = false;

    const retryOptions: RetryOptions = {
      maxAttempts: this.config.retry?.maxAttempts ?? 3,
      maxLfsRetries: this.config.retry?.maxLfsRetries ?? 2,
      initialDelayMs: this.config.retry?.initialDelayMs ?? 1000,
      maxDelayMs: this.config.retry?.maxDelayMs ?? 30000,
      backoffMultiplier: this.config.retry?.backoffMultiplier ?? 2,
      onRetry: (error, attempt, context) => {
        const errorMessage = getErrorMessage(error);
        console.log(`\n⚠️  Sync attempt ${attempt} failed: ${errorMessage}`);

        if (context?.isLfsError && !this.config.skipLfs) {
          console.log(`🔄 LFS error detected. Will retry with LFS skipped...`);
        } else {
          console.log(`🔄 Retrying synchronization...\n`);
        }
      },
      lfsRetryHandler: () => {
        if (!this.config.skipLfs && !lfsSkipEnabled) {
          console.log("⚠️  Temporarily disabling LFS downloads for this sync...");
          process.env.GIT_LFS_SKIP_SMUDGE = "1";
          lfsSkipEnabled = true;
        }
      },
    };

    try {
      await retry(async () => {
        await this.gitService.pruneWorktrees();

        console.log("Step 1: Fetching latest data from remote...");

        try {
          await this.gitService.fetchAll();
        } catch (fetchError) {
          const errorMessage = getErrorMessage(fetchError);

          if (isLfsError(errorMessage) && !lfsSkipEnabled && !this.config.skipLfs) {
            console.log("⚠️  Fetch all failed due to LFS error. Attempting branch-by-branch fetch...");
            console.log("⚠️  Temporarily disabling LFS downloads for branch-by-branch fetch...");
            process.env.GIT_LFS_SKIP_SMUDGE = "1";
            lfsSkipEnabled = true;
            await this.fetchBranchByBranch();
          } else {
            throw fetchError;
          }
        }

        let remoteBranches: string[];

        if (this.config.branchMaxAge) {
          const branchesWithActivity = await this.gitService.getRemoteBranchesWithActivity();
          const filteredBranches = filterBranchesByAge(branchesWithActivity, this.config.branchMaxAge);
          remoteBranches = filteredBranches.map((b) => b.branch);

          console.log(`Found ${branchesWithActivity.length} remote branches.`);
          console.log(
            `After filtering by age (${formatDuration(this.config.branchMaxAge)}): ${remoteBranches.length} branches.`,
          );

          if (branchesWithActivity.length > remoteBranches.length) {
            const excludedCount = branchesWithActivity.length - remoteBranches.length;
            console.log(`  - Excluded ${excludedCount} stale branches.`);
          }
        } else {
          // Use original method if no age filtering
          remoteBranches = await this.gitService.getRemoteBranches();
          console.log(`Found ${remoteBranches.length} remote branches.`);
        }

        // Always retain the default branch, even if excluded by age filters
        const defaultBranch = this.gitService.getDefaultBranch();
        if (!remoteBranches.includes(defaultBranch)) {
          remoteBranches.push(defaultBranch);
          console.log(`Ensuring default branch '${defaultBranch}' is retained.`);
        }

        await fs.mkdir(this.config.worktreeDir, { recursive: true });

        // Get actual Git worktrees instead of just directories
        const worktrees = await this.gitService.getWorktrees();
        const worktreeBranches = worktrees.map((w) => w.branch);
        console.log(`Found ${worktrees.length} existing Git worktrees.`);

        // Clean up orphaned directories
        await this.cleanupOrphanedDirectories(worktrees);

        await this.createNewWorktrees(remoteBranches, worktreeBranches, defaultBranch);

        await this.pruneOldWorktrees(remoteBranches, worktreeBranches);

        // Update existing worktrees if enabled
        if (this.config.updateExistingWorktrees !== false) {
          await this.updateExistingWorktrees(worktrees, remoteBranches);
        }

        await this.gitService.pruneWorktrees();
        console.log("Step 5: Pruned worktree metadata.");
      }, retryOptions);
    } catch (error) {
      console.error("\n❌ Error during worktree synchronization after all retry attempts:", error);
      throw error;
    } finally {
      if (lfsSkipEnabled && !this.config.skipLfs) {
        delete process.env.GIT_LFS_SKIP_SMUDGE;
      }
      this.syncInProgress = false;
      console.log(`[${new Date().toISOString()}] Synchronization finished.\n`);
    }
  }

  private async createNewWorktrees(
    remoteBranches: string[],
    existingWorktreeBranches: string[],
    defaultBranch: string,
  ): Promise<void> {
    const newBranches = remoteBranches
      .filter((b) => !existingWorktreeBranches.includes(b))
      .filter((b) => b !== defaultBranch);

    if (newBranches.length > 0) {
      console.log(`Step 2: Creating ${newBranches.length} new worktrees...`);

      // Worktree creation has concurrency=1 by default because Git's worktree.lock
      // can cause race conditions when multiple operations run simultaneously.
      // If concurrent operations try to create the same worktree, we gracefully handle
      // the "already registered" error by checking if the worktree actually exists.
      const maxConcurrent =
        this.config.parallelism?.maxWorktreeCreation ?? DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_CREATION;
      const limit = pLimit(maxConcurrent);

      const results = await Promise.allSettled(
        newBranches.map((branchName) =>
          limit(async () => {
            const worktreePath = path.join(this.config.worktreeDir, branchName);
            try {
              await this.gitService.addWorktree(branchName, worktreePath);
              console.log(`  ✅ Created worktree for '${branchName}'`);
            } catch (error) {
              console.error(`  ❌ Failed to create worktree for '${branchName}':`, getErrorMessage(error));
              throw error;
            }
          }),
        ),
      );

      const successCount = results.filter((r) => r.status === "fulfilled").length;
      console.log(`  Created ${successCount}/${newBranches.length} worktrees successfully`);
    } else {
      console.log("Step 2: No new branches to create worktrees for.");
    }
  }

  private async pruneOldWorktrees(remoteBranches: string[], existingWorktreeBranches: string[]): Promise<void> {
    const deletedBranches = existingWorktreeBranches.filter((branch) => !remoteBranches.includes(branch));

    if (deletedBranches.length > 0) {
      console.log(`Step 3: Checking ${deletedBranches.length} stale worktrees to prune...`);

      // Two-phase approach: First check status in parallel (read-only, safe),
      // then remove worktrees in parallel (mutation, needs lower concurrency)
      const maxConcurrent = this.config.parallelism?.maxStatusChecks ?? DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS;
      const limit = pLimit(maxConcurrent);

      const statusResults = await Promise.allSettled(
        deletedBranches.map((branchName) =>
          limit(async () => {
            const worktreePath = path.join(this.config.worktreeDir, branchName);
            const status = await this.gitService.getFullWorktreeStatus(worktreePath, this.config.debug);
            return { branchName, worktreePath, status };
          }),
        ),
      );

      const toRemove: Array<{ branchName: string; worktreePath: string }> = [];
      const toSkip: Array<{
        branchName: string;
        status: Awaited<ReturnType<GitService["getFullWorktreeStatus"]>>;
      }> = [];

      for (const result of statusResults) {
        if (result.status === "fulfilled") {
          const { branchName, worktreePath, status } = result.value;
          if (status.canRemove) {
            toRemove.push({ branchName, worktreePath });
          } else {
            toSkip.push({ branchName, status });
          }
        } else {
          console.error(`  - Error checking worktree:`, result.reason);
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
                await this.gitService.removeWorktree(worktreePath);
                console.log(`  ✅ Removed worktree for '${branchName}'`);
              } catch (error) {
                console.error(`  ❌ Failed to remove worktree for '${branchName}':`, getErrorMessage(error));
                throw error;
              }
            }),
          ),
        );

        const removedCount = removeResults.filter((r) => r.status === "fulfilled").length;
        console.log(`  Removed ${removedCount}/${toRemove.length} worktrees successfully`);
      }

      if (toSkip.length > 0) {
        console.log(`  Skipped ${toSkip.length} worktree(s) with local changes or unpushed commits`);
      }

      for (const { branchName, status } of toSkip) {
        if (status.upstreamGone && status.hasUnpushedCommits) {
          const worktreePath = path.join(this.config.worktreeDir, branchName);
          console.warn(`  - ⚠️ Cannot automatically remove '${branchName}' - upstream branch was deleted.`);
          console.log(`     Please review manually: cd ${worktreePath} && git log`);
          console.log(
            `     If changes were squash-merged, you can safely remove with: git worktree remove ${worktreePath}`,
          );
        } else {
          console.log(`  - ⚠️ Skipping removal of '${branchName}' due to: ${status.reasons.join(", ")}.`);
        }

        if (this.config.debug && status.details) {
          this.logDebugDetails(branchName, status.details);
        }
      }
    } else {
      console.log("Step 3: No stale worktrees to prune.");
    }
  }

  private logDebugDetails(branchName: string, details: WorktreeStatusDetails): void {
    console.log(`\n     🔍 Debug details for '${branchName}':`);

    if (details.modifiedFiles > 0 && details.modifiedFilesList) {
      console.log(`        - Modified files (${details.modifiedFiles}):`);
      details.modifiedFilesList.forEach((file) => console.log(`          • ${file}`));
    }
    if (details.deletedFiles > 0 && details.deletedFilesList) {
      console.log(`        - Deleted files (${details.deletedFiles}):`);
      details.deletedFilesList.forEach((file) => console.log(`          • ${file}`));
    }
    if (details.renamedFiles > 0 && details.renamedFilesList) {
      console.log(`        - Renamed files (${details.renamedFiles}):`);
      details.renamedFilesList.forEach((file) => console.log(`          • ${file.from} → ${file.to}`));
    }
    if (details.createdFiles > 0 && details.createdFilesList) {
      console.log(`        - Created files (${details.createdFiles}):`);
      details.createdFilesList.forEach((file) => console.log(`          • ${file}`));
    }
    if (details.conflictedFiles > 0 && details.conflictedFilesList) {
      console.log(`        - Conflicted files (${details.conflictedFiles}):`);
      details.conflictedFilesList.forEach((file) => console.log(`          • ${file}`));
    }
    if (details.untrackedFiles > 0 && details.untrackedFilesList) {
      console.log(`        - Untracked files (not ignored) (${details.untrackedFiles}):`);
      details.untrackedFilesList.forEach((file) => console.log(`          • ${file}`));
    }
    if (details.unpushedCommitCount !== undefined && details.unpushedCommitCount > 0) {
      console.log(`        - Unpushed commits: ${details.unpushedCommitCount}`);
    }
    if (details.stashCount !== undefined && details.stashCount > 0) {
      console.log(`        - Stashed changes: ${details.stashCount}`);
    }
    if (details.operationType) {
      console.log(`        - Operation in progress: ${details.operationType}`);
    }
    if (details.modifiedSubmodules && details.modifiedSubmodules.length > 0) {
      console.log(`        - Modified submodules (${details.modifiedSubmodules.length}):`);
      details.modifiedSubmodules.forEach((submodule) => console.log(`          • ${submodule}`));
    }

    console.log("");
  }

  private async fetchBranchByBranch(): Promise<void> {
    console.log("Fetching branches individually to isolate LFS errors...");

    // First, get the list of remote branches (this shouldn't fail due to LFS)
    const remoteBranches = await this.gitService.getRemoteBranches();
    console.log(`Found ${remoteBranches.length} remote branches to fetch.`);

    const failedBranches: string[] = [];
    let successCount = 0;

    for (const branch of remoteBranches) {
      try {
        await this.gitService.fetchBranch(branch);
        successCount++;
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.log(`  ⚠️  Failed to fetch branch '${branch}': ${errorMessage}`);
        failedBranches.push(branch);
      }
    }

    console.log(`Branch-by-branch fetch completed: ${successCount}/${remoteBranches.length} successful`);

    if (failedBranches.length > 0) {
      console.log(`⚠️  Failed to fetch ${failedBranches.length} branches due to errors.`);
      console.log(`   These branches will be skipped: ${failedBranches.join(", ")}`);
    }
  }

  private async updateExistingWorktrees(
    worktrees: { path: string; branch: string }[],
    remoteBranches: string[],
  ): Promise<void> {
    console.log("Step 4: Checking for worktrees that need updates...");

    const divergedDir = path.join(this.config.worktreeDir, ".diverged");
    try {
      const diverged = await fs.readdir(divergedDir);
      if (diverged.length > 0) {
        console.log(`📦 Note: ${diverged.length} diverged worktree(s) in ${path.relative(process.cwd(), divergedDir)}`);
      }
    } catch {
      // No diverged directory, that's fine
    }

    const activeWorktrees = worktrees.filter((w) => remoteBranches.includes(w.branch));

    // Two-phase approach: Check which worktrees need updates (parallel, read-only),
    // then perform updates (parallel with lower concurrency to avoid conflicts)
    const maxConcurrent = this.config.parallelism?.maxStatusChecks ?? DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS;
    const limit = pLimit(maxConcurrent);

    const checkResults = await Promise.allSettled(
      activeWorktrees.map((worktree) =>
        limit(async () => {
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
            await this.handleDivergedBranch(worktree);
            return null;
          }

          const isBehind = await this.gitService.isWorktreeBehind(worktree.path);
          return isBehind ? worktree : null;
        }),
      ),
    );

    const worktreesToUpdate: { path: string; branch: string }[] = [];
    for (const result of checkResults) {
      if (result.status === "fulfilled" && result.value) {
        worktreesToUpdate.push(result.value);
      } else if (result.status === "rejected") {
        console.error(`  - Error checking worktree:`, result.reason);
      }
    }

    if (worktreesToUpdate.length > 0) {
      console.log(`  - Found ${worktreesToUpdate.length} worktrees behind their upstream branches.`);

      const updateLimit = pLimit(
        this.config.parallelism?.maxWorktreeUpdates ?? DEFAULT_CONFIG.PARALLELISM.MAX_WORKTREE_UPDATES,
      );

      const updateResults = await Promise.allSettled(
        worktreesToUpdate.map((worktree) =>
          updateLimit(async () => {
            try {
              console.log(`  - Updating worktree '${worktree.branch}'...`);
              await this.gitService.updateWorktree(worktree.path);
              console.log(`    ✅ Successfully updated '${worktree.branch}'.`);
            } catch (error) {
              const errorMessage = getErrorMessage(error);

              if (
                errorMessage.includes("Not possible to fast-forward") ||
                errorMessage.includes("fatal: Not possible to fast-forward, aborting") ||
                errorMessage.includes("cannot fast-forward")
              ) {
                console.log(`    ⚠️ Branch '${worktree.branch}' cannot be fast-forwarded. Checking for divergence...`);
                try {
                  await this.handleDivergedBranch(worktree);
                } catch (divergedError) {
                  console.error(`    ❌ Failed to handle diverged branch '${worktree.branch}':`, divergedError);
                }
              } else {
                console.error(`    ❌ Failed to update '${worktree.branch}':`, error);
              }
              throw error;
            }
          }),
        ),
      );

      const successCount = updateResults.filter((r) => r.status === "fulfilled").length;
      console.log(`  Updated ${successCount}/${worktreesToUpdate.length} worktrees successfully`);
    } else {
      console.log("  - All worktrees are up to date.");
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
        console.log(`Found ${orphanedDirs.length} orphaned directories: ${orphanedDirs.join(", ")}`);

        for (const dir of orphanedDirs) {
          const dirPath = path.join(this.config.worktreeDir, dir);
          try {
            const stat = await fs.stat(dirPath);
            if (stat.isDirectory()) {
              await fs.rm(dirPath, { recursive: true, force: true });
              console.log(`  - Removed orphaned directory: ${dir}`);
            }
          } catch (error) {
            console.error(`  - Failed to remove orphaned directory ${dir}:`, error);
          }
        }
      }
    } catch (error) {
      console.error("Error during orphaned directory cleanup:", error);
    }
  }

  private async handleDivergedBranch(worktree: { path: string; branch: string }): Promise<void> {
    console.log(`⚠️  Branch '${worktree.branch}' has diverged from upstream. Analyzing...`);

    const treesIdentical = await this.gitService.compareTreeContent(worktree.path, worktree.branch);

    if (treesIdentical) {
      console.log(`✅ Branch '${worktree.branch}' was rebased but files are identical. Resetting to upstream...`);
      await this.gitService.resetToUpstream(worktree.path, worktree.branch);
      console.log(`   Successfully updated '${worktree.branch}' to match upstream.`);
    } else {
      const hasLocalChanges = await this.hasLocalChangesSinceLastSync(worktree.path);

      if (!hasLocalChanges) {
        console.log(
          `✅ Branch '${worktree.branch}' has diverged but you made no local changes. Resetting to upstream...`,
        );
        await this.gitService.resetToUpstream(worktree.path, worktree.branch);
        console.log(`   Successfully updated '${worktree.branch}' to match upstream.`);
      } else {
        console.log(`🔒 Branch '${worktree.branch}' has diverged with local changes. Moving to diverged...`);

        const divergedPath = await this.divergeWorktree(worktree.path, worktree.branch);
        const relativePath = path.relative(process.cwd(), divergedPath);

        console.log(`   Moved to: ${relativePath}`);
        console.log(`   Your local changes are preserved. To review:`);
        console.log(`     cd ${relativePath}`);
        console.log(`     git diff origin/${worktree.branch}`);

        await this.gitService.removeWorktree(worktree.path);
        await this.gitService.addWorktree(worktree.branch, worktree.path);
        console.log(`   Created fresh worktree from upstream at: ${worktree.path}`);
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
    const divergedBaseDir = path.join(this.config.worktreeDir, ".diverged");

    const timestamp = new Date().toISOString().split("T")[0];
    const uniqueSuffix = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
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
      reason: "diverged-history-with-changes",
      originalPath: worktreePath,
      localCommit: await this.gitService.getCurrentCommit(divergedPath),
      remoteCommit: await this.gitService.getRemoteCommit(`origin/${branchName}`),
      instruction: `To preserve your changes:
  1. Review: git diff origin/${branchName}
  2. Keep changes: git push --force-with-lease origin ${branchName}
  3. Discard changes: rm -rf this directory

  Original worktree location: ${worktreePath}`,
    };

    await fs.writeFile(path.join(divergedPath, ".diverged-info.json"), JSON.stringify(metadata, null, 2));

    return divergedPath;
  }
}
