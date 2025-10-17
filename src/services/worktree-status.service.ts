import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";

import { GIT_OPERATIONS, PATH_CONSTANTS } from "../constants";
import { GitOperationError, WorktreeNotCleanError } from "../errors";
import { getErrorMessage } from "../utils/lfs-error";

import type { SimpleGit } from "simple-git";

export interface WorktreeStatusResult {
  isClean: boolean;
  hasUnpushedCommits: boolean;
  hasStashedChanges: boolean;
  hasOperationInProgress: boolean;
  hasModifiedSubmodules: boolean;
  upstreamGone: boolean;
  canRemove: boolean;
  reasons: string[];
}

export class WorktreeStatusService {
  constructor(private readonly config: { skipLfs?: boolean } = {}) {}

  async checkWorktreeStatus(worktreePath: string): Promise<boolean> {
    const worktreeGit = this.createGitInstance(worktreePath);
    const status = await worktreeGit.status();
    return status.isClean();
  }

  async getFullWorktreeStatus(worktreePath: string): Promise<WorktreeStatusResult> {
    const isClean = await this.checkWorktreeStatus(worktreePath);
    const hasUnpushedCommits = await this.hasUnpushedCommits(worktreePath);
    const hasStashedChanges = await this.hasStashedChanges(worktreePath);
    const hasOperationInProgress = await this.hasOperationInProgress(worktreePath);
    const hasModifiedSubmodules = await this.hasModifiedSubmodules(worktreePath);
    const upstreamGone = hasUnpushedCommits && (await this.hasUpstreamGone(worktreePath));

    const reasons: string[] = [];
    if (!isClean) reasons.push("uncommitted changes");
    if (hasUnpushedCommits) reasons.push("unpushed commits");
    if (hasStashedChanges) reasons.push("stashed changes");
    if (hasOperationInProgress) reasons.push("operation in progress");
    if (hasModifiedSubmodules) reasons.push("modified submodules");

    const canRemove =
      isClean && !hasUnpushedCommits && !hasStashedChanges && !hasOperationInProgress && !hasModifiedSubmodules;

    return {
      isClean,
      hasUnpushedCommits,
      hasStashedChanges,
      hasOperationInProgress,
      hasModifiedSubmodules,
      upstreamGone,
      canRemove,
      reasons,
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
        if (firstChar === "+" || firstChar === "-") {
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

  async validateWorktreeForRemoval(worktreePath: string): Promise<void> {
    const status = await this.getFullWorktreeStatus(worktreePath);

    if (!status.canRemove) {
      throw new WorktreeNotCleanError(worktreePath, status.reasons);
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
        const gitdirMatch = content.match(/^gitdir:\s*(.+)$/m);
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
