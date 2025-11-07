import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";

import { GIT_CONSTANTS, GIT_OPERATIONS, PATH_CONSTANTS } from "../constants";
import { GitOperationError, WorktreeNotCleanError } from "../errors";
import { getErrorMessage } from "../utils/lfs-error";

import type { SimpleGit } from "simple-git";

export interface WorktreeStatusDetails {
  modifiedFiles: number;
  deletedFiles: number;
  renamedFiles: number;
  createdFiles: number;
  conflictedFiles: number;
  untrackedFiles: number;
  unpushedCommitCount?: number;
  stashCount?: number;
  operationType?: string;
  modifiedSubmodules?: string[];
  modifiedFilesList?: string[];
  deletedFilesList?: string[];
  renamedFilesList?: Array<{ from: string; to: string }>;
  createdFilesList?: string[];
  conflictedFilesList?: string[];
  untrackedFilesList?: string[];
}

export interface WorktreeStatusResult {
  isClean: boolean;
  hasUnpushedCommits: boolean;
  hasStashedChanges: boolean;
  hasOperationInProgress: boolean;
  hasModifiedSubmodules: boolean;
  upstreamGone: boolean;
  canRemove: boolean;
  reasons: string[];
  details?: WorktreeStatusDetails;
}

export class WorktreeStatusService {
  constructor(private readonly config: { skipLfs?: boolean } = {}) {}

  async checkWorktreeStatus(worktreePath: string): Promise<boolean> {
    const worktreeGit = this.createGitInstance(worktreePath);
    const status = await worktreeGit.status();

    const hasTrackedChanges =
      status.modified.length > 0 ||
      status.deleted.length > 0 ||
      status.renamed.length > 0 ||
      status.created.length > 0 ||
      status.conflicted.length > 0;

    if (hasTrackedChanges) {
      return false;
    }

    if (status.not_added.length > 0) {
      const untrackedFiles = status.not_added;
      const notIgnoredFiles = await this.filterUntrackedFiles(worktreePath, untrackedFiles);
      return notIgnoredFiles.length === 0;
    }

    return true;
  }

  async getFullWorktreeStatus(
    worktreePath: string,
    includeDetails = false,
    lastSyncCommit?: string,
  ): Promise<WorktreeStatusResult> {
    const isClean = await this.checkWorktreeStatus(worktreePath);
    const hasUnpushedCommits = await this.hasUnpushedCommits(worktreePath, lastSyncCommit);
    const hasStashedChanges = await this.hasStashedChanges(worktreePath);
    const hasOperationInProgress = await this.hasOperationInProgress(worktreePath);
    const hasModifiedSubmodules = await this.hasModifiedSubmodules(worktreePath);
    const upstreamGone = await this.hasUpstreamGone(worktreePath);

    const reasons: string[] = [];
    if (!isClean) reasons.push("uncommitted changes");
    if (hasUnpushedCommits) reasons.push("unpushed commits");
    if (hasStashedChanges) reasons.push("stashed changes");
    if (hasOperationInProgress) reasons.push("operation in progress");
    if (hasModifiedSubmodules) reasons.push("modified submodules");

    const canRemove =
      isClean && !hasUnpushedCommits && !hasStashedChanges && !hasOperationInProgress && !hasModifiedSubmodules;

    let details: WorktreeStatusDetails | undefined;
    if (includeDetails) {
      details = await this.getStatusDetails(worktreePath);
    }

    return {
      isClean,
      hasUnpushedCommits,
      hasStashedChanges,
      hasOperationInProgress,
      hasModifiedSubmodules,
      upstreamGone,
      canRemove,
      reasons,
      details,
    };
  }

  async hasUnpushedCommits(worktreePath: string, lastSyncCommit?: string): Promise<boolean> {
    const worktreeGit = this.createGitInstance(worktreePath);

    try {
      if (await this.isDetachedHead(worktreeGit)) {
        return false;
      }

      const branchSummary = await worktreeGit.branch();
      const currentBranch = branchSummary.current;

      if (lastSyncCommit) {
        try {
          const newCommitsResult = await worktreeGit.raw(["rev-list", "--count", `${lastSyncCommit}..HEAD`]);
          const newCommitsCount = parseInt(newCommitsResult.trim(), 10);
          return newCommitsCount > 0;
        } catch {
          // Fall through to regular check
        }
      }

      const result = await worktreeGit.raw(["rev-list", "--count", currentBranch, "--not", "--remotes"]);
      const unpushedCount = parseInt(result.trim(), 10);
      return unpushedCount > 0;
    } catch (error) {
      console.error(`Error checking unpushed commits: ${error}`);
      return false;
    }
  }

  async hasUpstreamGone(worktreePath: string): Promise<boolean> {
    const worktreeGit = this.createGitInstance(worktreePath);

    try {
      if (await this.isDetachedHead(worktreeGit)) {
        return false;
      }

      const branchSummary = await worktreeGit.branch();
      const currentBranch = branchSummary.current;

      const upstream = await worktreeGit.raw(["rev-parse", "--abbrev-ref", `${currentBranch}@{upstream}`]);
      const remoteBranches = await worktreeGit.branch(["-r"]);

      return !remoteBranches.all.includes(upstream.trim());
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      if (
        errorMessage.includes("fatal: no upstream configured") ||
        errorMessage.includes("no upstream configured for branch") ||
        errorMessage.includes("fatal: ambiguous argument") ||
        errorMessage.includes("unknown revision or path")
      ) {
        return false;
      }

      console.error(`Unexpected error checking upstream status for ${worktreePath}: ${errorMessage}`);
      return false;
    }
  }

  async hasStashedChanges(worktreePath: string): Promise<boolean> {
    const worktreeGit = this.createGitInstance(worktreePath);

    try {
      const stashList = await worktreeGit.stashList();
      return stashList.total > 0;
    } catch (error) {
      console.error(`Error checking stash: ${error}`);
      return true; // Conservative: assume unsafe to delete
    }
  }

  async hasModifiedSubmodules(worktreePath: string): Promise<boolean> {
    const worktreeGit = this.createGitInstance(worktreePath);

    try {
      const result = await worktreeGit.raw(["submodule", "status"]);
      const lines = result.split("\n").filter((line) => line.trim());

      for (const line of lines) {
        const firstChar = line.charAt(0);
        if (
          firstChar === GIT_CONSTANTS.SUBMODULE_STATUS_ADDED ||
          firstChar === GIT_CONSTANTS.SUBMODULE_STATUS_REMOVED
        ) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async hasOperationInProgress(worktreePath: string): Promise<boolean> {
    try {
      const gitDir = await this.resolveGitDir(worktreePath);

      const operationFiles = [
        GIT_OPERATIONS.MERGE_HEAD,
        GIT_OPERATIONS.CHERRY_PICK_HEAD,
        GIT_OPERATIONS.REVERT_HEAD,
        GIT_OPERATIONS.BISECT_LOG,
        GIT_OPERATIONS.REBASE_MERGE,
        GIT_OPERATIONS.REBASE_APPLY,
      ];

      for (const file of operationFiles) {
        try {
          await fs.access(path.join(gitDir, file));
          return true;
        } catch {
          continue;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  async validateWorktreeForRemoval(worktreePath: string, lastSyncCommit?: string): Promise<void> {
    const status = await this.getFullWorktreeStatus(worktreePath, false, lastSyncCommit);

    if (!status.canRemove) {
      throw new WorktreeNotCleanError(worktreePath, status.reasons);
    }
  }

  async getStatusDetails(worktreePath: string): Promise<WorktreeStatusDetails> {
    const worktreeGit = this.createGitInstance(worktreePath);
    const status = await worktreeGit.status();

    const details: WorktreeStatusDetails = {
      modifiedFiles: status.modified.length,
      deletedFiles: status.deleted.length,
      renamedFiles: status.renamed.length,
      createdFiles: status.created.length,
      conflictedFiles: status.conflicted.length,
      untrackedFiles: 0,
    };

    if (status.modified.length > 0) {
      details.modifiedFilesList = status.modified;
    }
    if (status.deleted.length > 0) {
      details.deletedFilesList = status.deleted;
    }
    if (status.renamed.length > 0) {
      details.renamedFilesList = status.renamed.map((r) => ({ from: r.from, to: r.to }));
    }
    if (status.created.length > 0) {
      details.createdFilesList = status.created;
    }
    if (status.conflicted.length > 0) {
      details.conflictedFilesList = status.conflicted;
    }

    if (status.not_added.length > 0) {
      const notIgnoredFiles = await this.filterUntrackedFiles(worktreePath, status.not_added);
      details.untrackedFiles = notIgnoredFiles.length;
      if (notIgnoredFiles.length > 0) {
        details.untrackedFilesList = notIgnoredFiles;
      }
    }

    try {
      if (!(await this.isDetachedHead(worktreeGit))) {
        const branchSummary = await worktreeGit.branch();
        const currentBranch = branchSummary.current;
        const result = await worktreeGit.raw(["rev-list", "--count", currentBranch, "--not", "--remotes"]);
        details.unpushedCommitCount = parseInt(result.trim(), 10);
      }
    } catch {
      details.unpushedCommitCount = undefined;
    }

    try {
      const stashList = await worktreeGit.stashList();
      details.stashCount = stashList.total;
    } catch {
      details.stashCount = undefined;
    }

    const operationType = await this.getOperationType(worktreePath);
    if (operationType) {
      details.operationType = operationType;
    }

    try {
      const result = await worktreeGit.raw(["submodule", "status"]);
      const lines = result.split("\n").filter((line) => line.trim());
      const modifiedSubmodules: string[] = [];

      for (const line of lines) {
        const firstChar = line.charAt(0);
        if (
          firstChar === GIT_CONSTANTS.SUBMODULE_STATUS_ADDED ||
          firstChar === GIT_CONSTANTS.SUBMODULE_STATUS_REMOVED
        ) {
          const match = line.match(/^[+-]\s*(\S+)/);
          if (match) {
            modifiedSubmodules.push(match[1]);
          }
        }
      }

      if (modifiedSubmodules.length > 0) {
        details.modifiedSubmodules = modifiedSubmodules;
      }
    } catch {
      // No submodules or error
    }

    return details;
  }

  private async getOperationType(worktreePath: string): Promise<string | undefined> {
    try {
      const gitDir = await this.resolveGitDir(worktreePath);

      const operations = [
        { file: GIT_OPERATIONS.MERGE_HEAD, type: "merge" },
        { file: GIT_OPERATIONS.CHERRY_PICK_HEAD, type: "cherry-pick" },
        { file: GIT_OPERATIONS.REVERT_HEAD, type: "revert" },
        { file: GIT_OPERATIONS.BISECT_LOG, type: "bisect" },
        { file: GIT_OPERATIONS.REBASE_MERGE, type: "rebase" },
        { file: GIT_OPERATIONS.REBASE_APPLY, type: "rebase (apply)" },
      ];

      for (const op of operations) {
        try {
          await fs.access(path.join(gitDir, op.file));
          return op.type;
        } catch {
          continue;
        }
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  private async filterUntrackedFiles(worktreePath: string, files: string[]): Promise<string[]> {
    if (files.length === 0) return [];

    const worktreeGit = this.createGitInstance(worktreePath);

    try {
      const result = await worktreeGit.raw(["check-ignore", "--", ...files]);

      const ignoredFiles = new Set(
        result
          .trim()
          .split("\n")
          .filter((f) => f),
      );
      return files.filter((f) => !ignoredFiles.has(f));
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      if (errorMessage.includes(GIT_CONSTANTS.GIT_CHECK_IGNORE_NO_MATCH)) {
        return files;
      }

      console.warn(`Warning: Could not check gitignore status for files in ${worktreePath}: ${errorMessage}`);
      return files;
    }
  }

  private async isDetachedHead(worktreeGit: SimpleGit): Promise<boolean> {
    try {
      const branchSummary = await worktreeGit.branch();
      return !branchSummary.current || branchSummary.detached;
    } catch {
      return true;
    }
  }

  private async resolveGitDir(worktreePath: string): Promise<string> {
    const gitPath = path.join(worktreePath, PATH_CONSTANTS.GIT_DIR);

    try {
      const stat = await fs.stat(gitPath);

      if (stat.isFile()) {
        const content = await fs.readFile(gitPath, "utf-8");
        const gitdirMatch = content.match(new RegExp(`^${GIT_CONSTANTS.GITDIR_PREFIX}\\s*(.+)$`, "m"));
        if (gitdirMatch) {
          return path.resolve(worktreePath, gitdirMatch[1].trim());
        }
      }

      return gitPath;
    } catch (error) {
      throw new GitOperationError(
        "resolve-git-dir",
        `Failed to resolve .git directory for ${worktreePath}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  private createGitInstance(worktreePath: string): SimpleGit {
    const git = simpleGit(worktreePath);
    return this.config.skipLfs ? git.env({ GIT_LFS_SKIP_SMUDGE: "1" }) : git;
  }
}
