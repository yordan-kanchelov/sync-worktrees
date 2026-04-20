import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";

import { GIT_CONSTANTS, METADATA_CONSTANTS } from "../constants";

import { Logger } from "./logger.service";

import type { SyncMetadata } from "../types/sync-metadata";

export class WorktreeMetadataService {
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? Logger.createDefault();
  }

  /**
   * Gets the internal worktree directory name from a worktree path.
   * Git uses the basename of the worktree path as the internal directory name.
   * For example: /worktrees/fix/test-branch -> test-branch (not fix/test-branch)
   */
  private getWorktreeDirectoryName(worktreePath: string): string {
    return path.basename(worktreePath);
  }

  async getMetadataPath(bareRepoPath: string, worktreeName: string): Promise<string> {
    // Replace slashes with dashes to avoid nested directory creation
    // while keeping uniqueness (e.g., "feature/test" -> "feature-test")
    const sanitizedName = worktreeName.replace(/\//g, "-");
    return path.join(
      bareRepoPath,
      METADATA_CONSTANTS.WORKTREE_METADATA_PATH,
      sanitizedName,
      METADATA_CONSTANTS.METADATA_FILENAME,
    );
  }

  async getMetadataPathFromWorktreePath(bareRepoPath: string, worktreePath: string): Promise<string> {
    // Extract the worktree directory name (basename) that Git actually uses
    const worktreeDirName = this.getWorktreeDirectoryName(worktreePath);
    return this.getMetadataPath(bareRepoPath, worktreeDirName);
  }

  async saveMetadata(bareRepoPath: string, worktreeName: string, metadata: SyncMetadata): Promise<void> {
    const metadataPath = await this.getMetadataPath(bareRepoPath, worktreeName);
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });

    // Write to temp file then rename for atomicity — prevents corruption on crash
    const tmpPath = metadataPath + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(metadata, null, 2), "utf-8");
    try {
      await fs.rename(tmpPath, metadataPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        // Cross-device rename not supported: copy contents then remove temp file
        await fs.copyFile(tmpPath, metadataPath);
        await fs.unlink(tmpPath);
      } else {
        throw err;
      }
    }
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

  async loadMetadataFromPath(bareRepoPath: string, worktreePath: string): Promise<SyncMetadata | null> {
    const metadataPath = await this.getMetadataPathFromWorktreePath(bareRepoPath, worktreePath);

    try {
      const content = await fs.readFile(metadataPath, "utf-8");
      const metadata = JSON.parse(content) as SyncMetadata;

      if (!(await this.validateMetadata(metadata))) {
        this.logger.warn(`Corrupted metadata for ${worktreePath}, treating as missing`);
        return null;
      }

      return metadata;
    } catch {
      // Fallback: try loading from old path (using branch name with slashes)
      // This handles migration from the old broken path structure
      try {
        const branchName = path.basename(worktreePath);
        // Check if branch name might have had slashes (parent dir would exist)
        const parentDir = path.dirname(worktreePath);
        const possibleBranchWithSlash = path.join(path.basename(parentDir), branchName);

        // Try the old path with potential slash in branch name
        const oldPath = path.join(
          bareRepoPath,
          METADATA_CONSTANTS.WORKTREE_METADATA_PATH,
          possibleBranchWithSlash,
          METADATA_CONSTANTS.METADATA_FILENAME,
        );
        const content = await fs.readFile(oldPath, "utf-8");
        const metadata = JSON.parse(content) as SyncMetadata;

        if (!(await this.validateMetadata(metadata))) {
          this.logger.warn(`Corrupted metadata at old path ${oldPath}, treating as missing`);
          return null;
        }

        // Migrate to new path
        await this.saveMetadata(bareRepoPath, this.getWorktreeDirectoryName(worktreePath), metadata);

        // Clean up old path
        try {
          await fs.unlink(oldPath);
          // Try to remove empty parent directory
          await fs.rm(path.dirname(oldPath), { recursive: false, force: true });
        } catch {
          // Ignore cleanup errors
        }

        return metadata;
      } catch {
        // Return null if file doesn't exist or can't be parsed
        return null;
      }
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

  async deleteMetadataFromPath(bareRepoPath: string, worktreePath: string): Promise<void> {
    const metadataPath = await this.getMetadataPathFromWorktreePath(bareRepoPath, worktreePath);

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
      this.logger.warn(`No metadata found for worktree ${worktreeName}, creating initial metadata`);
      await this.createInitialMetadata(
        bareRepoPath,
        worktreeName,
        commit,
        `origin/${worktreeName}`,
        GIT_CONSTANTS.DEFAULT_BRANCH,
        commit,
      );
      return;
    }

    existing.lastSyncCommit = commit;
    existing.lastSyncDate = new Date().toISOString();

    existing.syncHistory.push({
      date: existing.lastSyncDate,
      commit,
      action,
    });

    if (existing.syncHistory.length > METADATA_CONSTANTS.MAX_HISTORY_ENTRIES) {
      existing.syncHistory = existing.syncHistory.slice(-METADATA_CONSTANTS.MAX_HISTORY_ENTRIES);
    }

    await this.saveMetadata(bareRepoPath, worktreeName, existing);
  }

  async updateLastSyncFromPath(
    bareRepoPath: string,
    worktreePath: string,
    commit: string,
    action: "created" | "updated" | "fetched" = "updated",
    defaultBranch?: string,
  ): Promise<void> {
    const worktreeDirName = this.getWorktreeDirectoryName(worktreePath);
    const existing = await this.loadMetadataFromPath(bareRepoPath, worktreePath);

    if (!existing) {
      this.logger.warn(`No metadata found for worktree ${worktreeDirName}`);
      this.logger.info(`  Attempting to create initial metadata...`);

      try {
        const worktreeGit = simpleGit(worktreePath);
        const currentCommit = await worktreeGit.revparse(["HEAD"]);

        const branchSummary = await worktreeGit.branch();
        const actualBranchName = branchSummary.current;

        if (!actualBranchName) {
          throw new Error("Could not determine current branch name");
        }

        let upstreamBranch = `origin/${actualBranchName}`;
        try {
          const configuredUpstream = await worktreeGit.raw([
            "rev-parse",
            "--abbrev-ref",
            `${actualBranchName}@{upstream}`,
          ]);
          if (configuredUpstream.trim()) {
            upstreamBranch = configuredUpstream.trim();
          }
        } catch {
          // No configured upstream, use constructed value
        }

        const parentBranch = defaultBranch || GIT_CONSTANTS.DEFAULT_BRANCH;

        await this.createInitialMetadataFromPath(
          bareRepoPath,
          worktreePath,
          currentCommit.trim(),
          upstreamBranch,
          parentBranch,
          currentCommit.trim(),
        );
        this.logger.info(`  ✅ Created metadata for ${worktreeDirName}`);
        return;
      } catch (error) {
        this.logger.error(`  ❌ Failed to create metadata`, error);
        throw error;
      }
    }

    // Update metadata
    existing.lastSyncCommit = commit;
    existing.lastSyncDate = new Date().toISOString();

    existing.syncHistory.push({
      date: existing.lastSyncDate,
      commit,
      action,
    });

    if (existing.syncHistory.length > METADATA_CONSTANTS.MAX_HISTORY_ENTRIES) {
      existing.syncHistory = existing.syncHistory.slice(-METADATA_CONSTANTS.MAX_HISTORY_ENTRIES);
    }

    // Save using the directory name
    await this.saveMetadata(bareRepoPath, worktreeDirName, existing);
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

  async createInitialMetadataFromPath(
    bareRepoPath: string,
    worktreePath: string,
    commit: string,
    upstreamBranch: string,
    parentBranch: string,
    parentCommit: string,
  ): Promise<void> {
    const worktreeDirName = this.getWorktreeDirectoryName(worktreePath);
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

    await this.saveMetadata(bareRepoPath, worktreeDirName, metadata);
  }

  async validateMetadata(metadata: SyncMetadata): Promise<boolean> {
    if (!metadata.lastSyncCommit || !metadata.lastSyncDate || !metadata.upstreamBranch) {
      return false;
    }

    if (!/^[0-9a-f]+$/i.test(metadata.lastSyncCommit)) {
      return false;
    }

    if (Number.isNaN(new Date(metadata.lastSyncDate).getTime())) {
      return false;
    }

    return true;
  }
}
