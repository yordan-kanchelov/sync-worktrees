import * as fs from "fs/promises";
import * as path from "path";

import type { SyncMetadata } from "../types/sync-metadata";

export class WorktreeMetadataService {
  async getMetadataPath(bareRepoPath: string, worktreeName: string): Promise<string> {
    // Git stores worktree metadata in .git/worktrees/[worktree-name]/
    // We'll store our metadata alongside Git's metadata
    return path.join(bareRepoPath, ".git", "worktrees", worktreeName, "sync-metadata.json");
  }

  async saveMetadata(bareRepoPath: string, worktreeName: string, metadata: SyncMetadata): Promise<void> {
    const metadataPath = await this.getMetadataPath(bareRepoPath, worktreeName);

    // Ensure directory exists
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });

    // Write metadata as JSON
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");
  }

  async loadMetadata(bareRepoPath: string, worktreeName: string): Promise<SyncMetadata | null> {
    const metadataPath = await this.getMetadataPath(bareRepoPath, worktreeName);

    try {
      const content = await fs.readFile(metadataPath, "utf-8");
      return JSON.parse(content) as SyncMetadata;
    } catch {
      // Return null if file doesn't exist or can't be parsed
      return null;
    }
  }

  async deleteMetadata(bareRepoPath: string, worktreeName: string): Promise<void> {
    const metadataPath = await this.getMetadataPath(bareRepoPath, worktreeName);

    try {
      await fs.unlink(metadataPath);
    } catch (error) {
      // Ignore errors if file doesn't exist
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  async updateLastSync(
    bareRepoPath: string,
    worktreeName: string,
    commit: string,
    action: "created" | "updated" | "fetched" = "updated",
  ): Promise<void> {
    const existing = await this.loadMetadata(bareRepoPath, worktreeName);

    if (!existing) {
      // If no metadata exists, we can't update it
      console.warn(`No metadata found for worktree ${worktreeName}, skipping update`);
      return;
    }

    // Update metadata
    existing.lastSyncCommit = commit;
    existing.lastSyncDate = new Date().toISOString();

    // Add to history (limit to last 10 entries)
    existing.syncHistory.push({
      date: existing.lastSyncDate,
      commit,
      action,
    });

    if (existing.syncHistory.length > 10) {
      existing.syncHistory = existing.syncHistory.slice(-10);
    }

    await this.saveMetadata(bareRepoPath, worktreeName, existing);
  }

  async createInitialMetadata(
    bareRepoPath: string,
    worktreeName: string,
    commit: string,
    upstreamBranch: string,
    parentBranch: string,
    parentCommit: string,
  ): Promise<void> {
    const metadata: SyncMetadata = {
      lastSyncCommit: commit,
      lastSyncDate: new Date().toISOString(),
      upstreamBranch,
      createdFrom: {
        branch: parentBranch,
        commit: parentCommit,
      },
      syncHistory: [
        {
          date: new Date().toISOString(),
          commit,
          action: "created",
        },
      ],
    };

    await this.saveMetadata(bareRepoPath, worktreeName, metadata);
  }
}
