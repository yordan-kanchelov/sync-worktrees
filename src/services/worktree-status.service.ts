import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";

import { ENV_CONSTANTS, GIT_CONSTANTS, GIT_OPERATIONS, PATH_CONSTANTS } from "../constants";
import { GitOperationError, WorktreeNotCleanError } from "../errors";
import { getErrorMessage } from "../utils/lfs-error";

import { Logger } from "./logger.service";

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

const OPERATION_FILES: ReadonlyArray<{ file: string; type: string }> = [
  { file: GIT_OPERATIONS.MERGE_HEAD, type: "merge" },
  { file: GIT_OPERATIONS.CHERRY_PICK_HEAD, type: "cherry-pick" },
  { file: GIT_OPERATIONS.REVERT_HEAD, type: "revert" },
  { file: GIT_OPERATIONS.BISECT_LOG, type: "bisect" },
  { file: GIT_OPERATIONS.REBASE_MERGE, type: "rebase" },
  { file: GIT_OPERATIONS.REBASE_APPLY, type: "rebase (apply)" },
];

interface WorktreeSnapshot {
  exists: boolean;
  status: Awaited<ReturnType<SimpleGit["status"]>> | null;
  currentBranch: string | null;
  detached: boolean;
  remoteBranches: string[];
  upstream: string | null;
  unpushedCount: number | null;
  stashTotal: number | null;
  submoduleStatus: string | null;
  operationFile: string | null;
  gitDir: string | null;
  untrackedNotIgnored: string[];
}

export class WorktreeStatusService {
  private gitInstances = new Map<string, SimpleGit>();
  private logger: Logger;

  constructor(
    private readonly config: { skipLfs?: boolean } = {},
    logger?: Logger,
  ) {
    this.logger = logger ?? Logger.createDefault();
  }

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
    try {
      await fs.access(worktreePath);
    } catch {
      return {
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        canRemove: true,
        reasons: [],
      };
    }

    const snap = await this.collectSnapshot(worktreePath, lastSyncCommit);

    const isClean = this.deriveIsClean(snap);
    const hasUnpushedCommits = !snap.detached && (snap.unpushedCount ?? 1) > 0;
    const hasStashedChanges = snap.stashTotal === null ? true : snap.stashTotal > 0;
    const hasOperationInProgress = snap.gitDir === null ? true : snap.operationFile !== null;
    const hasModifiedSubmodules = this.deriveModifiedSubmodules(snap).length > 0 || snap.submoduleStatus === null;
    const upstreamGone =
      !snap.detached && snap.upstream !== null && snap.remoteBranches.length > 0
        ? !snap.remoteBranches.includes(snap.upstream)
        : false;

    const reasons: string[] = [];
    if (!isClean) reasons.push("uncommitted changes");
    if (hasUnpushedCommits) reasons.push("unpushed commits");
    if (hasOperationInProgress) reasons.push("operation in progress");
    if (hasModifiedSubmodules) reasons.push("modified submodules");
    if (upstreamGone) reasons.push("upstream gone");

    const canRemove = isClean && !hasUnpushedCommits && !hasOperationInProgress && !hasModifiedSubmodules;

    const details: WorktreeStatusDetails | undefined = includeDetails ? this.buildStatusDetails(snap) : undefined;

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

  private async collectSnapshot(worktreePath: string, lastSyncCommit?: string): Promise<WorktreeSnapshot> {
    const git = this.createGitInstance(worktreePath);

    const [status, branchResult, remoteBranchesResult, stashResult, submoduleResult, gitDirResult] = await Promise.all([
      git.status().catch((e: unknown) => {
        this.logger.error(`Error reading status for ${worktreePath}`, e);
        return null;
      }),
      git.branch().catch(() => null),
      git.branch(["-r"]).catch(() => null),
      git.stashList().catch((e: unknown) => {
        this.logger.error(`Error checking stash`, e);
        return null;
      }),
      git.raw(["submodule", "status"]).catch((e: unknown) => {
        this.logger.error(`Error checking submodule status`, e);
        return null;
      }),
      this.resolveGitDir(worktreePath).catch((e: unknown) => {
        this.logger.error(`Error checking operation in progress for ${worktreePath}`, e);
        return null;
      }),
    ]);

    const currentBranch = branchResult?.current ?? null;
    const detached = !branchResult?.current || Boolean((branchResult as { detached?: boolean })?.detached);

    let upstream: string | null = null;
    let unpushedCount: number | null = null;
    if (!detached && currentBranch) {
      const revListArgs = lastSyncCommit
        ? ["rev-list", "--count", `${lastSyncCommit}..HEAD`]
        : ["rev-list", "--count", currentBranch, "--not", "--remotes"];

      const [upstreamResult, unpushedResult] = await Promise.all([
        git.raw(["rev-parse", "--abbrev-ref", `${currentBranch}@{upstream}`]).then(
          (raw) => ({ ok: true as const, value: raw }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
        git.raw(revListArgs).then(
          (raw) => ({ ok: true as const, value: raw }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      ]);

      if (upstreamResult.ok) {
        upstream = upstreamResult.value.trim() || null;
      } else {
        const errorMessage = getErrorMessage(upstreamResult.error);
        if (
          !errorMessage.includes("fatal: no upstream configured") &&
          !errorMessage.includes("no upstream configured for branch") &&
          !errorMessage.includes("fatal: ambiguous argument") &&
          !errorMessage.includes("unknown revision or path")
        ) {
          this.logger.error(`Unexpected error checking upstream status for ${worktreePath}: ${errorMessage}`);
        }
      }

      if (unpushedResult.ok) {
        unpushedCount = parseInt(unpushedResult.value.trim(), 10);
      } else {
        this.logger.error(`Error checking unpushed commits`, unpushedResult.error);
      }
    }

    const operationFile = gitDirResult ? await this.detectOperationFile(gitDirResult) : null;

    let untrackedNotIgnored: string[] = [];
    if (status && status.not_added.length > 0) {
      try {
        untrackedNotIgnored = await this.filterUntrackedFiles(worktreePath, status.not_added);
      } catch {
        untrackedNotIgnored = status.not_added;
      }
    }

    return {
      exists: true,
      status,
      currentBranch,
      detached,
      remoteBranches: remoteBranchesResult?.all ?? [],
      upstream,
      unpushedCount,
      stashTotal: stashResult?.total ?? null,
      submoduleStatus: submoduleResult,
      operationFile,
      gitDir: gitDirResult,
      untrackedNotIgnored,
    };
  }

  private deriveIsClean(snap: WorktreeSnapshot): boolean {
    const status = snap.status;
    if (!status) return false;
    const hasTracked =
      status.modified.length > 0 ||
      status.deleted.length > 0 ||
      status.renamed.length > 0 ||
      status.created.length > 0 ||
      status.conflicted.length > 0;
    if (hasTracked) return false;
    return snap.untrackedNotIgnored.length === 0;
  }

  private deriveModifiedSubmodules(snap: WorktreeSnapshot): string[] {
    if (!snap.submoduleStatus) return [];
    const modified: string[] = [];
    for (const line of snap.submoduleStatus.split("\n").filter((l) => l.trim())) {
      const firstChar = line.charAt(0);
      if (firstChar === GIT_CONSTANTS.SUBMODULE_STATUS_ADDED || firstChar === GIT_CONSTANTS.SUBMODULE_STATUS_REMOVED) {
        const match = line.match(/^[+-]\s*(\S+)/);
        if (match) modified.push(match[1]);
      }
    }
    return modified;
  }

  private buildStatusDetails(snap: WorktreeSnapshot): WorktreeStatusDetails {
    const status = snap.status;
    const details: WorktreeStatusDetails = {
      modifiedFiles: status?.modified.length ?? 0,
      deletedFiles: status?.deleted.length ?? 0,
      renamedFiles: status?.renamed.length ?? 0,
      createdFiles: status?.created.length ?? 0,
      conflictedFiles: status?.conflicted.length ?? 0,
      untrackedFiles: snap.untrackedNotIgnored.length,
    };
    if (status) {
      if (status.modified.length > 0) details.modifiedFilesList = status.modified;
      if (status.deleted.length > 0) details.deletedFilesList = status.deleted;
      if (status.renamed.length > 0) {
        details.renamedFilesList = status.renamed.map((r) => ({ from: r.from, to: r.to }));
      }
      if (status.created.length > 0) details.createdFilesList = status.created;
      if (status.conflicted.length > 0) details.conflictedFilesList = status.conflicted;
    }
    if (snap.untrackedNotIgnored.length > 0) details.untrackedFilesList = snap.untrackedNotIgnored;
    if (!snap.detached && snap.unpushedCount !== null) details.unpushedCommitCount = snap.unpushedCount;
    if (snap.stashTotal !== null) details.stashCount = snap.stashTotal;
    const opType = this.operationTypeFromFile(snap.operationFile);
    if (opType) details.operationType = opType;
    const modSubs = this.deriveModifiedSubmodules(snap);
    if (modSubs.length > 0) details.modifiedSubmodules = modSubs;
    return details;
  }

  private operationTypeFromFile(file: string | null): string | undefined {
    if (!file) return undefined;
    return OPERATION_FILES.find((op) => op.file === file)?.type;
  }

  private async detectOperationFile(gitDir: string): Promise<string | null> {
    const results = await Promise.all(
      OPERATION_FILES.map(({ file }) =>
        fs.access(path.join(gitDir, file)).then(
          () => true,
          () => false,
        ),
      ),
    );
    const idx = results.findIndex(Boolean);
    return idx >= 0 ? OPERATION_FILES[idx].file : null;
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
      this.logger.error(`Error checking unpushed commits`, error);
      return true;
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

      this.logger.error(`Unexpected error checking upstream status for ${worktreePath}: ${errorMessage}`);
      return true;
    }
  }

  async hasStashedChanges(worktreePath: string): Promise<boolean> {
    const worktreeGit = this.createGitInstance(worktreePath);

    try {
      const stashList = await worktreeGit.stashList();
      return stashList.total > 0;
    } catch (error) {
      this.logger.error(`Error checking stash`, error);
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
    } catch (error) {
      this.logger.error(`Error checking submodule status`, error);
      return true;
    }
  }

  async hasOperationInProgress(worktreePath: string): Promise<boolean> {
    try {
      const gitDir = await this.resolveGitDir(worktreePath);
      return (await this.detectOperationFile(gitDir)) !== null;
    } catch (error) {
      this.logger.error(`Error checking operation in progress for ${worktreePath}`, error);
      return true;
    }
  }

  async validateWorktreeForRemoval(worktreePath: string, lastSyncCommit?: string): Promise<void> {
    const status = await this.getFullWorktreeStatus(worktreePath, false, lastSyncCommit);

    if (!status.canRemove) {
      throw new WorktreeNotCleanError(worktreePath, status.reasons);
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

      throw error;
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
        throw new GitOperationError("resolve-git-dir", `Failed to parse gitdir from .git file at ${gitPath}`);
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
    const key = `${path.resolve(worktreePath)}::${this.config.skipLfs ? "1" : "0"}`;
    let git = this.gitInstances.get(key);
    if (!git) {
      git = this.config.skipLfs
        ? simpleGit(worktreePath).env({ [ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE]: "1" })
        : simpleGit(worktreePath);
      this.gitInstances.set(key, git);
    }
    return git;
  }
}
