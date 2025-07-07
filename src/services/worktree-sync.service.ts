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
      // 1. Fetch latest changes and prune deleted remote branches
      console.log("Step 1: Fetching latest data from remote...");
      await this.gitService.fetchAll();

      // 2. Get remote branches
      const remoteBranches = await this.gitService.getRemoteBranches();
      console.log(`Found ${remoteBranches.length} remote branches.`);

      // 3. Get existing worktree directories
      await fs.mkdir(this.config.worktreeDir, { recursive: true });
      const worktreeDirs = await fs.readdir(this.config.worktreeDir);
      console.log(`Found ${worktreeDirs.length} existing worktree directories.`);

      // 4. Create new worktrees
      await this.createNewWorktrees(remoteBranches, worktreeDirs);

      // 5. Prune old worktrees (with safety check)
      await this.pruneOldWorktrees(remoteBranches, worktreeDirs);

      // 6. Cleanup
      await this.gitService.pruneWorktrees();
      console.log("Step 4: Pruned worktree metadata.");
    } catch (error) {
      console.error("Error during worktree synchronization:", error);
      throw error;
    } finally {
      console.log(`[${new Date().toISOString()}] Synchronization finished.\n`);
    }
  }

  private async createNewWorktrees(remoteBranches: string[], worktreeDirs: string[]): Promise<void> {
    const newBranches = remoteBranches.filter((b) => !worktreeDirs.includes(b));

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

  private async pruneOldWorktrees(remoteBranches: string[], worktreeDirs: string[]): Promise<void> {
    const deletedBranches = worktreeDirs.filter((dir) => !remoteBranches.includes(dir));

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
}
