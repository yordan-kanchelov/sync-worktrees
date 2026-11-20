import * as fs from "fs/promises";
import * as path from "path";

import { GIT_CONSTANTS, METADATA_CONSTANTS } from "../constants";
import { atomicWriteFile } from "../utils/atomic-write";
import { createGitClient } from "../utils/git-client";

import { Logger } from "./logger.service";

import type { SyncMetadata } from "../types/sync-metadata";

export class WorktreeMetadataService {
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? Logger.createDefault();
  }

  updateLogger(logger: Logger): void {
    this.logger = logger;
  }

  private getWorktreeDirectoryName(worktreePath: string): string {
    return path.basename(worktreePath);
  }

  async getMetadataPath(bareRepoPath: string, worktreeName: string): Promise<string> {
    if (worktreeName.includes("/") || worktreeName.includes("\\")) {
      throw new Error(
        `getMetadataPath requires a filesystem-safe worktree directory name, got '${worktreeName}'. Use getMetadataPathFromWorktreePath when starting from a raw branch name.`,
      );
    }
    return path.join(
      bareRepoPath,
      METADATA_CONSTANTS.WORKTREE_METADATA_PATH,
      worktreeName,
      METADATA_CONSTANTS.METADATA_FILENAME,
    );
  }

  async getMetadataPathFromWorktreePath(bareRepoPath: string, worktreePath: string): Promise<string> {
    const worktreeDirName = this.getWorktreeDirectoryName(worktreePath);
    return this.getMetadataPath(bareRepoPath, worktreeDirName);
  }

  async saveMetadata(bareRepoPath: string, worktreeName: string, metadata: SyncMetadata): Promise<boolean> {
    const metadataPath = await this.getMetadataPath(bareRepoPath, worktreeName);
    const existing = await this.loadMetadata(bareRepoPath, worktreeName);
    if (existing && (await this.validateMetadata(existing)) && existing.upstreamBranch !== metadata.upstreamBranch) {
      this.logger.warn(
        `Refusing to overwrite metadata for ${worktreeName}: existing upstream ${existing.upstreamBranch} differs from ${metadata.upstreamBranch}`,
      );
      return false;
    }
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await atomicWriteFile(metadataPath, JSON.stringify(metadata, null, 2));
    return true;
  }

  async loadMetadata(bareRepoPath: string, worktreeName: string): Promise<SyncMetadata | null> {
    const metadataPath = await this.getMetadataPath(bareRepoPath, worktreeName);

    try {
      const content = await fs.readFile(metadataPath, "utf-8");
      return JSON.parse(content) as SyncMetadata;
    } catch {
      return null;
    }
  }

  async readMetadataOwner(bareRepoPath: string, worktreeName: string): Promise<string | null> {
    const existing = await this.loadMetadata(bareRepoPath, worktreeName);
    if (!existing || !(await this.validateMetadata(existing))) return null;
    const upstream = existing.upstreamBranch;
    return upstream.startsWith(GIT_CONSTANTS.REMOTE_PREFIX)
      ? upstream.slice(GIT_CONSTANTS.REMOTE_PREFIX.length)
      : upstream;
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
      return null;
    }
  }

  async deleteMetadataFromPath(bareRepoPath: string, worktreePath: string): Promise<void> {
    const metadataPath = await this.getMetadataPathFromWorktreePath(bareRepoPath, worktreePath);

    try {
      await fs.unlink(metadataPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  async updateLastSyncFromPath(bareRepoPath: string, worktreePath: string, commit: string): Promise<void> {
    const worktreeDirName = this.getWorktreeDirectoryName(worktreePath);
    const existing = await this.loadMetadataFromPath(bareRepoPath, worktreePath);

    if (!existing) {
      this.logger.warn(`No metadata found for worktree ${worktreeDirName}`);
      this.logger.info(`  Attempting to create initial metadata...`);

      try {
        const worktreeGit = createGitClient(worktreePath);
        const currentCommit = await worktreeGit.revparse(["HEAD"]);

        const headRef = (await worktreeGit.raw(["symbolic-ref", "-q", "HEAD"])).trim();
        const actualBranchName = headRef.startsWith(GIT_CONSTANTS.REFS.HEADS)
          ? headRef.slice(GIT_CONSTANTS.REFS.HEADS.length)
          : "";

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
        } catch {}

        const created = await this.createInitialMetadataFromPath(
          bareRepoPath,
          worktreePath,
          currentCommit.trim(),
          upstreamBranch,
        );
        if (created) {
          this.logger.info(`  ✅ Created metadata for ${worktreeDirName}`);
        } else {
          this.logger.warn(`  ⚠️ Metadata for ${worktreeDirName} was not overwritten`);
        }
        return;
      } catch (error) {
        this.logger.error(`  ❌ Failed to create metadata`, error);
        throw error;
      }
    }

    existing.lastSyncCommit = commit;
    existing.lastSyncDate = new Date().toISOString();

    await this.saveMetadata(bareRepoPath, worktreeDirName, existing);
  }

  async recordRemoteTip(bareRepoPath: string, worktreePath: string, ref: string, oid: string): Promise<void> {
    const worktreeDirName = this.getWorktreeDirectoryName(worktreePath);
    const existing = await this.loadMetadataFromPath(bareRepoPath, worktreePath);

    if (!existing) {
      this.logger.debug(`No metadata found for worktree ${worktreeDirName}; skipping remote tip recording`);
      return;
    }

    if (existing.lastKnownRemoteTip?.ref === ref && existing.lastKnownRemoteTip.oid === oid) {
      return;
    }

    existing.lastKnownRemoteTip = { ref, oid, recordedAt: new Date().toISOString() };
    await this.saveMetadata(bareRepoPath, worktreeDirName, existing);
  }

  async createInitialMetadataFromPath(
    bareRepoPath: string,
    worktreePath: string,
    commit: string,
    upstreamBranch: string,
  ): Promise<boolean> {
    const worktreeDirName = this.getWorktreeDirectoryName(worktreePath);
    const metadata: SyncMetadata = {
      lastSyncCommit: commit,
      lastSyncDate: new Date().toISOString(),
      upstreamBranch,
    };

    return this.saveMetadata(bareRepoPath, worktreeDirName, metadata);
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
