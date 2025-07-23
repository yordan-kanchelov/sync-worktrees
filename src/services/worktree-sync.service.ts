import * as fs from "fs/promises";
import * as path from "path";

import { filterBranchesByAge, formatDuration } from "../utils/date-filter";
import { isLfsError } from "../utils/lfs-error";
import { retry } from "../utils/retry";

import { GitService } from "./git.service";

import type { Config } from "../types";
import type { RetryOptions } from "../utils/retry";

export class WorktreeSyncService {
  private gitService: GitService;

  constructor(private config: Config) {
    this.gitService = new GitService(config);
  }

  async initialize(): Promise<void> {
    await this.gitService.initialize();
  }

  async sync(): Promise<void> {
    console.log(`[${new Date().toISOString()}] Starting worktree synchronization...`);

    let lfsSkipEnabled = false;

    const retryOptions: RetryOptions = {
      maxAttempts: this.config.retry?.maxAttempts ?? 3,
      maxLfsRetries: this.config.retry?.maxLfsRetries ?? 2,
      initialDelayMs: this.config.retry?.initialDelayMs ?? 1000,
      maxDelayMs: this.config.retry?.maxDelayMs ?? 30000,
      backoffMultiplier: this.config.retry?.backoffMultiplier ?? 2,
      onRetry: (error, attempt, context) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
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
        console.log("Step 1: Fetching latest data from remote...");

        try {
          await this.gitService.fetchAll();
        } catch (fetchError) {
          const errorMessage = fetchError instanceof Error ? fetchError.message : String(fetchError);

          // If it's an LFS error and we haven't already enabled skip, try branch-by-branch
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
          // Get branches with activity data and filter by age
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

        await fs.mkdir(this.config.worktreeDir, { recursive: true });

        // Get actual Git worktrees instead of just directories
        const worktrees = await this.gitService.getWorktrees();
        const worktreeBranches = worktrees.map((w) => w.branch);
        console.log(`Found ${worktrees.length} existing Git worktrees.`);

        // Clean up orphaned directories
        await this.cleanupOrphanedDirectories(worktrees);

        const defaultBranch = this.gitService.getDefaultBranch();
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
      // Clean up temporary LFS skip if it was enabled
      if (lfsSkipEnabled && !this.config.skipLfs) {
        delete process.env.GIT_LFS_SKIP_SMUDGE;
      }
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
      console.log(`Step 2: Creating new worktrees for: ${newBranches.join(", ")}`);
      for (const branchName of newBranches) {
        const worktreePath = path.join(this.config.worktreeDir, branchName);
        await this.gitService.addWorktree(branchName, worktreePath);
      }
    } else {
      console.log("Step 2: No new branches to create worktrees for.");
    }
  }

  private async pruneOldWorktrees(remoteBranches: string[], existingWorktreeBranches: string[]): Promise<void> {
    const deletedBranches = existingWorktreeBranches.filter((branch) => !remoteBranches.includes(branch));

    if (deletedBranches.length > 0) {
      console.log(`Step 3: Checking for stale worktrees to prune: ${deletedBranches.join(", ")}`);

      for (const branchName of deletedBranches) {
        const worktreePath = path.join(this.config.worktreeDir, branchName);

        try {
          const isClean = await this.gitService.checkWorktreeStatus(worktreePath);
          const hasUnpushed = await this.gitService.hasUnpushedCommits(worktreePath);
          const hasStash = await this.gitService.hasStashedChanges(worktreePath);
          const hasOperation = await this.gitService.hasOperationInProgress(worktreePath);
          const hasDirtySubmodules = await this.gitService.hasModifiedSubmodules(worktreePath);

          const canDelete = isClean && !hasUnpushed && !hasStash && !hasOperation && !hasDirtySubmodules;

          if (canDelete) {
            await this.gitService.removeWorktree(worktreePath);
          } else {
            // Check if upstream is gone for better messaging
            const upstreamGone = hasUnpushed && (await this.gitService.hasUpstreamGone(worktreePath));

            if (upstreamGone) {
              console.warn(`  - ⚠️ Cannot automatically remove '${branchName}' - upstream branch was deleted.`);
              console.log(`     Please review manually: cd ${worktreePath} && git log`);
              console.log(
                `     If changes were squash-merged, you can safely remove with: git worktree remove ${worktreePath}`,
              );
            } else {
              // Log specific reasons for skipping
              const reasons: string[] = [];
              if (!isClean) reasons.push("uncommitted changes");
              if (hasUnpushed) reasons.push("unpushed commits");
              if (hasStash) reasons.push("stashed changes");
              if (hasOperation) reasons.push("operation in progress");
              if (hasDirtySubmodules) reasons.push("modified submodules");

              console.log(`  - ⚠️ Skipping removal of '${branchName}' due to: ${reasons.join(", ")}.`);
            }
          }
        } catch (error) {
          console.error(`  - Error checking worktree '${branchName}':`, error);
        }
      }
    } else {
      console.log("Step 3: No stale worktrees to prune.");
    }
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
        const errorMessage = error instanceof Error ? error.message : String(error);
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
    const worktreesToUpdate: { path: string; branch: string }[] = [];

    console.log("Step 4: Checking for worktrees that need updates...");

    // Check for diverged worktrees
    const divergedDir = path.join(this.config.worktreeDir, ".diverged");
    try {
      const diverged = await fs.readdir(divergedDir);
      if (diverged.length > 0) {
        console.log(`📦 Note: ${diverged.length} diverged worktree(s) in ${path.relative(process.cwd(), divergedDir)}`);
      }
    } catch {
      // No diverged directory, that's fine
    }

    // Only check worktrees whose branches still exist remotely
    const activeWorktrees = worktrees.filter((w) => remoteBranches.includes(w.branch));

    // Check each active worktree to see if it's behind and clean
    for (const worktree of activeWorktrees) {
      try {
        // First check if the worktree directory actually exists
        try {
          await fs.access(worktree.path);
        } catch {
          // Directory doesn't exist, skip it
          continue;
        }

        const isClean = await this.gitService.checkWorktreeStatus(worktree.path);
        if (!isClean) {
          continue; // Skip worktrees with local changes
        }

        // Check if we can fast-forward before attempting update
        const canFastForward = await this.gitService.canFastForward(worktree.path, worktree.branch);
        if (!canFastForward) {
          // Handle diverged branch
          await this.handleDivergedBranch(worktree);
          continue;
        }

        const isBehind = await this.gitService.isWorktreeBehind(worktree.path);
        if (isBehind) {
          worktreesToUpdate.push(worktree);
        }
      } catch (error) {
        console.error(`  - Error checking worktree '${worktree.branch}':`, error);
      }
    }

    if (worktreesToUpdate.length > 0) {
      console.log(`  - Found ${worktreesToUpdate.length} worktrees behind their upstream branches.`);

      for (const worktree of worktreesToUpdate) {
        try {
          console.log(`  - Updating worktree '${worktree.branch}'...`);
          await this.gitService.updateWorktree(worktree.path);
          console.log(`    ✅ Successfully updated '${worktree.branch}'.`);
        } catch (error) {
          console.error(`    ❌ Failed to update '${worktree.branch}':`, error);
        }
      }
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
      console.log(`🔒 Branch '${worktree.branch}' has diverged with different content. Moving to diverged...`);

      const divergedPath = await this.divergeWorktree(worktree.path, worktree.branch);
      const relativePath = path.relative(process.cwd(), divergedPath);

      console.log(`   Moved to: ${relativePath}`);
      console.log(`   Your local changes are preserved. To review:`);
      console.log(`     cd ${relativePath}`);
      console.log(`     git diff origin/${worktree.branch}`);

      // Create fresh worktree from upstream
      await this.gitService.removeWorktree(worktree.path);
      await this.gitService.addWorktree(worktree.branch, worktree.path);
      console.log(`   Created fresh worktree from upstream at: ${worktree.path}`);
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

    // Move the worktree directory
    await fs.rename(worktreePath, divergedPath);

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
