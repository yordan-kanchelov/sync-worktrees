import * as fs from "fs/promises";
import * as path from "path";

import { GitService } from "./git.service";

import type { Config } from "../types";

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

    try {
      console.log("Step 1: Fetching latest data from remote...");
      await this.gitService.fetchAll();

      const remoteBranches = await this.gitService.getRemoteBranches();
      console.log(`Found ${remoteBranches.length} remote branches.`);

      await fs.mkdir(this.config.worktreeDir, { recursive: true });

      // Get actual Git worktrees instead of just directories
      const worktrees = await this.gitService.getWorktrees();
      const worktreeBranches = worktrees.map((w) => w.branch);
      console.log(`Found ${worktrees.length} existing Git worktrees.`);

      // Clean up orphaned directories
      await this.cleanupOrphanedDirectories(worktrees);

      const currentBranch = await this.gitService.getCurrentBranch();
      await this.createNewWorktrees(remoteBranches, worktreeBranches, currentBranch);

      await this.pruneOldWorktrees(remoteBranches, worktreeBranches);

      await this.gitService.pruneWorktrees();
      console.log("Step 4: Pruned worktree metadata.");
    } catch (error) {
      console.error("Error during worktree synchronization:", error);
      throw error;
    } finally {
      console.log(`[${new Date().toISOString()}] Synchronization finished.\n`);
    }
  }

  private async createNewWorktrees(
    remoteBranches: string[],
    existingWorktreeBranches: string[],
    currentBranch: string,
  ): Promise<void> {
    const newBranches = remoteBranches
      .filter((b) => !existingWorktreeBranches.includes(b))
      .filter((b) => b !== currentBranch);

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

          if (isClean && !hasUnpushed) {
            await this.gitService.removeWorktree(branchName);
          } else {
            if (!isClean) {
              console.log(`  - ⚠️ Skipping removal of '${branchName}' as it has uncommitted changes.`);
            }
            if (hasUnpushed) {
              console.log(`  - ⚠️ Skipping removal of '${branchName}' as it has unpushed commits.`);
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

  private async cleanupOrphanedDirectories(worktrees: { path: string; branch: string }[]): Promise<void> {
    try {
      const worktreePaths = worktrees.map((w) => path.basename(w.path));
      const allDirs = await fs.readdir(this.config.worktreeDir);

      const orphanedDirs = allDirs.filter((dir) => !worktreePaths.includes(dir));

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
