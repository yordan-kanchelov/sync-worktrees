import * as fs from "fs/promises";
import * as path from "path";

import { filterBranchesByAge, formatDuration } from "../utils/date-filter";
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

    const retryOptions: RetryOptions = {
      maxAttempts: this.config.retry?.maxAttempts ?? 3,
      initialDelayMs: this.config.retry?.initialDelayMs ?? 1000,
      maxDelayMs: this.config.retry?.maxDelayMs ?? 30000,
      backoffMultiplier: this.config.retry?.backoffMultiplier ?? 2,
      onRetry: (error, attempt) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log(`\n⚠️  Sync attempt ${attempt} failed: ${errorMessage}`);
        console.log(`🔄 Retrying synchronization...\n`);
      },
    };

    try {
      await retry(async () => {
        console.log("Step 1: Fetching latest data from remote...");
        await this.gitService.fetchAll();

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

        await this.gitService.pruneWorktrees();
        console.log("Step 4: Pruned worktree metadata.");
      }, retryOptions);
    } catch (error) {
      console.error("\n❌ Error during worktree synchronization after all retry attempts:", error);
      throw error;
    } finally {
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
            // Log specific reasons for skipping
            const reasons: string[] = [];
            if (!isClean) reasons.push("uncommitted changes");
            if (hasUnpushed) reasons.push("unpushed commits");
            if (hasStash) reasons.push("stashed changes");
            if (hasOperation) reasons.push("operation in progress");
            if (hasDirtySubmodules) reasons.push("modified submodules");

            console.log(`  - ⚠️ Skipping removal of '${branchName}' due to: ${reasons.join(", ")}.`);
          }
        } catch (error) {
          console.error(`  - Error checking worktree '${branchName}':`, error);
        }
      }
    } else {
      console.log("Step 3: No stale worktrees to prune.");
    }
  }

  private async cleanupOrphanedDirectories(worktrees: { path: string; branch: string }[]): Promise<void> {
    try {
      const worktreeRelativePaths = worktrees.map((w) => path.relative(this.config.worktreeDir, w.path));
      const allDirs = await fs.readdir(this.config.worktreeDir);

      // For each directory, check if it's part of any worktree path
      const orphanedDirs: string[] = [];
      for (const dir of allDirs) {
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
}
