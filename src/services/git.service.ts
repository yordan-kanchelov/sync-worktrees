import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";

import { getDefaultBareRepoDir } from "../utils/git-url";
import { getErrorMessage } from "../utils/lfs-error";

import { WorktreeMetadataService } from "./worktree-metadata.service";
import { WorktreeStatusService } from "./worktree-status.service";

import type { Config } from "../types";
import type { WorktreeStatusResult } from "./worktree-status.service";
import type { SyncMetadata } from "../types/sync-metadata";
import type { SimpleGit } from "simple-git";

export class GitService {
  private git: SimpleGit | null = null;
  private bareRepoPath: string;
  private mainWorktreePath: string;
  private defaultBranch: string = "main"; // Will be updated after detection
  private metadataService: WorktreeMetadataService;
  private statusService: WorktreeStatusService;

  constructor(private config: Config) {
    this.bareRepoPath = this.config.bareRepoDir || getDefaultBareRepoDir(this.config.repoUrl);
    this.mainWorktreePath = path.join(this.config.worktreeDir, "main"); // Temporary, will be updated
    this.metadataService = new WorktreeMetadataService();
    this.statusService = new WorktreeStatusService({ skipLfs: this.config.skipLfs });
  }

  async initialize(): Promise<SimpleGit> {
    const { repoUrl } = this.config;

    try {
      // Check if bare repo already exists
      await fs.access(path.join(this.bareRepoPath, "HEAD"));
      console.log(`Bare repository at "${this.bareRepoPath}" already exists. Using it.`);
    } catch {
      // Clone as bare repository
      console.log(`Cloning from "${repoUrl}" as bare repository into "${this.bareRepoPath}"...`);
      await fs.mkdir(path.dirname(this.bareRepoPath), { recursive: true });
      const cloneGit = this.isLfsSkipEnabled() ? simpleGit().env({ GIT_LFS_SKIP_SMUDGE: "1" }) : simpleGit();
      await cloneGit.clone(repoUrl, this.bareRepoPath, ["--bare"]);
      console.log("✅ Clone successful.");
    }

    // Configure bare repository for worktrees
    const bareGit = simpleGit(this.bareRepoPath);

    // Check if fetch config already exists
    try {
      const existingConfig = await bareGit.raw(["config", "--get-all", "remote.origin.fetch"]);
      const targetConfig = "+refs/heads/*:refs/remotes/origin/*";

      if (!existingConfig.includes(targetConfig)) {
        await bareGit.addConfig("remote.origin.fetch", targetConfig);
      }
    } catch {
      // Config doesn't exist, add it
      await bareGit.addConfig("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    }

    // Fetch all remote branches to ensure they exist locally
    console.log("Fetching remote branches...");
    await bareGit.fetch(["--all"]);

    // Detect the default branch
    this.defaultBranch = await this.detectDefaultBranch(bareGit);
    this.mainWorktreePath = path.join(this.config.worktreeDir, this.defaultBranch);
    console.log(`Detected default branch: ${this.defaultBranch}`);

    // Check if main worktree exists
    let needsMainWorktree = true;
    try {
      const worktrees = await this.getWorktreesFromBare(bareGit);
      needsMainWorktree = !worktrees.some((w) => path.resolve(w.path) === path.resolve(this.mainWorktreePath));
    } catch {
      // If worktree list fails, assume we need main worktree
    }

    if (needsMainWorktree) {
      // Create main worktree if it doesn't exist
      console.log(`Creating ${this.defaultBranch} worktree at "${this.mainWorktreePath}"...`);
      await fs.mkdir(this.config.worktreeDir, { recursive: true });
      // Use absolute path for worktree add to avoid relative path issues
      const absoluteWorktreePath = path.resolve(this.mainWorktreePath);

      try {
        // Check if local branch exists
        const branches = await bareGit.branch();
        const defaultBranchExists = branches.all.includes(this.defaultBranch);

        if (defaultBranchExists) {
          await bareGit.raw(["worktree", "add", absoluteWorktreePath, this.defaultBranch]);
          // Set upstream tracking after creating worktree
          const worktreeGit = this.isLfsSkipEnabled()
            ? simpleGit(absoluteWorktreePath).env({ GIT_LFS_SKIP_SMUDGE: "1" })
            : simpleGit(absoluteWorktreePath);
          await worktreeGit.branch(["--set-upstream-to", `origin/${this.defaultBranch}`, this.defaultBranch]);
        } else {
          // Create new branch tracking the remote branch
          await bareGit.raw([
            "worktree",
            "add",
            "--track",
            "-b",
            this.defaultBranch,
            absoluteWorktreePath,
            `origin/${this.defaultBranch}`,
          ]);
        }
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        // Check if error is because directory already exists
        if (errorMessage.includes("already exists")) {
          console.log(
            `${this.defaultBranch} worktree directory already exists at '${absoluteWorktreePath}', skipping creation.`,
          );
        } else {
          // Fallback to simple add if tracking setup fails
          console.warn(`Failed to create ${this.defaultBranch} worktree with tracking, using simple add: ${error}`);
          try {
            await bareGit.raw(["worktree", "add", absoluteWorktreePath, this.defaultBranch]);
          } catch (fallbackError) {
            const fallbackErrorMessage = getErrorMessage(fallbackError);
            if (fallbackErrorMessage.includes("already exists")) {
              console.log(
                `${this.defaultBranch} worktree directory already exists at '${absoluteWorktreePath}', skipping creation.`,
              );
            } else {
              throw fallbackError;
            }
          }
        }
      }

      // Ensure the worktree is registered by checking it exists in the list
      const updatedWorktrees = await this.getWorktreesFromBare(bareGit);
      const mainWorktreeRegistered = updatedWorktrees.some(
        (w) => path.resolve(w.path) === path.resolve(this.mainWorktreePath),
      );

      if (!mainWorktreeRegistered) {
        // Only warn in non-test environments as this is common in tests due to Git state
        if (process.env.NODE_ENV !== "test") {
          console.warn(`Main worktree was created but not found in worktree list. This may cause issues.`);
        }
      }
    }

    // Use the main worktree as our primary git instance
    this.git = simpleGit(this.mainWorktreePath);
    return this.git;
  }

  getGit(): SimpleGit {
    if (!this.git) {
      throw new Error("Git service not initialized. Call initialize() first.");
    }
    return this.git;
  }

  getDefaultBranch(): string {
    return this.defaultBranch;
  }

  async fetchAll(): Promise<void> {
    const git = this.getGit();
    console.log("Fetching latest data from remote...");

    if (this.isLfsSkipEnabled()) {
      await git.env({ GIT_LFS_SKIP_SMUDGE: "1" }).fetch(["--all", "--prune"]);
    } else {
      await git.fetch(["--all", "--prune"]);
    }
  }

  async fetchBranch(branchName: string): Promise<void> {
    const git = this.getGit();

    // Update only the remote ref for the branch to keep refs/remotes/origin/* fresh
    if (this.isLfsSkipEnabled()) {
      await git.env({ GIT_LFS_SKIP_SMUDGE: "1" }).fetch(["origin", branchName, "--prune"]);
    } else {
      await git.fetch(["origin", branchName, "--prune"]);
    }
  }

  async getRemoteBranches(): Promise<string[]> {
    const git = this.getGit();
    const branches = await git.branch(["-r"]);
    return branches.all
      .filter((b) => b.startsWith("origin/") && !b.endsWith("/HEAD"))
      .map((b) => b.replace("origin/", ""))
      .filter((b) => b !== "origin" && b.length > 0);
  }

  async getRemoteBranchesWithActivity(): Promise<{ branch: string; lastActivity: Date }[]> {
    const git = this.getGit();
    // Use for-each-ref to get branch names with their last commit dates
    const result = await git.raw([
      "for-each-ref",
      "--format=%(refname:short)|%(committerdate:iso8601)",
      "refs/remotes/origin",
    ]);

    const branches: { branch: string; lastActivity: Date }[] = [];
    const lines = result
      .trim()
      .split("\n")
      .filter((line) => line);

    for (const line of lines) {
      const [ref, dateStr] = line.split("|", 2);
      if (ref && dateStr && !ref.endsWith("/HEAD")) {
        const branch = ref.replace("origin/", "");
        // Skip invalid branch names
        if (branch === "origin" || branch.length === 0) {
          continue;
        }
        const lastActivity = new Date(dateStr);
        // Skip if the date is invalid
        if (!isNaN(lastActivity.getTime())) {
          branches.push({ branch, lastActivity });
        }
      }
    }

    return branches;
  }

  private async verifyLfsFilesDownloaded(worktreePath: string, branchName: string): Promise<void> {
    const worktreeGit = simpleGit(worktreePath);

    try {
      const lfsFiles = await worktreeGit.raw(["lfs", "ls-files", "--name-only"]);
      const lfsFileList = lfsFiles
        .trim()
        .split("\n")
        .filter((f) => f.length > 0);

      if (lfsFileList.length === 0) {
        return;
      }

      if (this.config.debug) {
        console.log(`  - Verifying ${lfsFileList.length} LFS files are downloaded...`);
      }

      const sampleSize = Math.min(5, lfsFileList.length);
      const samplesToCheck = [];
      for (let i = 0; i < sampleSize; i++) {
        const randomIndex = Math.floor(Math.random() * lfsFileList.length);
        samplesToCheck.push(lfsFileList[randomIndex]);
      }

      let retries = 0;
      const maxRetries = 30;
      const retryDelay = 1000;

      while (retries < maxRetries) {
        let allDownloaded = true;
        const notDownloaded: string[] = [];

        for (const file of samplesToCheck) {
          const filePath = path.join(worktreePath, file);
          try {
            const handle = await fs.open(filePath, "r");
            try {
              const buffer = Buffer.alloc(200);
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
              const header = buffer.subarray(0, bytesRead).toString("utf8");
              if (header.startsWith("version https://git-lfs.github.com/spec/")) {
                allDownloaded = false;
                notDownloaded.push(file);
              }
            } finally {
              await handle.close();
            }
          } catch {
            allDownloaded = false;
            notDownloaded.push(file);
          }
        }

        if (allDownloaded) {
          if (this.config.debug) {
            console.log(`  - ✅ LFS files verified (${samplesToCheck.length} samples checked)`);
          }
          return;
        }

        retries++;
        if (retries < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
      }

      console.warn(
        `  - ⚠️ Warning: Some LFS files may not be fully downloaded after ${maxRetries} seconds. ` +
          `This might cause issues if tools access the worktree immediately.`,
      );
    } catch (error) {
      console.warn(`  - ⚠️ Warning: Could not verify LFS files for '${branchName}': ${error}`);
    }
  }

  private async createWorktreeMetadata(bareGit: SimpleGit, worktreePath: string, branchName: string): Promise<void> {
    try {
      const worktreeGit = this.isLfsSkipEnabled()
        ? simpleGit(worktreePath).env({ GIT_LFS_SKIP_SMUDGE: "1" })
        : simpleGit(worktreePath);
      const currentCommit = await worktreeGit.revparse(["HEAD"]);
      const parentCommit = await bareGit.revparse([this.defaultBranch]);

      await this.metadataService.createInitialMetadataFromPath(
        this.bareRepoPath,
        worktreePath,
        currentCommit.trim(),
        `origin/${branchName}`,
        this.defaultBranch,
        parentCommit.trim(),
      );
    } catch (metadataError) {
      console.error(`  - ❌ Failed to create metadata for '${branchName}': ${metadataError}`);
      throw new Error(`Metadata creation failed for ${branchName}. This worktree cannot be auto-managed.`);
    }
  }

  async addWorktree(branchName: string, worktreePath: string): Promise<void> {
    const bareGit = this.isLfsSkipEnabled()
      ? simpleGit(this.bareRepoPath).env({ GIT_LFS_SKIP_SMUDGE: "1" })
      : simpleGit(this.bareRepoPath);
    // Use absolute path for worktree add to avoid relative path issues
    const absoluteWorktreePath = path.resolve(worktreePath);
    // Ensure parent directory exists for nested branch paths
    await fs.mkdir(path.dirname(absoluteWorktreePath), { recursive: true });

    // Check if directory already exists (could be from a failed previous attempt)
    try {
      await fs.access(absoluteWorktreePath);
      // Directory exists - check if it's already a valid worktree
      const worktrees = await this.getWorktreesFromBare(bareGit);
      const isValidWorktree = worktrees.some((w) => path.resolve(w.path) === absoluteWorktreePath);

      if (isValidWorktree) {
        console.log(`  - Worktree for '${branchName}' already exists at '${absoluteWorktreePath}'`);
        return;
      } else {
        // Directory exists but is not a valid worktree - clean it up
        console.log(`  - Cleaning up orphaned directory at '${absoluteWorktreePath}'`);
        await fs.rm(absoluteWorktreePath, { recursive: true, force: true });
      }
    } catch {
      // Directory doesn't exist, which is expected - continue with creation
    }

    try {
      // Check if local branch already exists
      const branches = await bareGit.branch();
      const localBranchExists = branches.all.includes(branchName);

      if (localBranchExists || branchName.includes("/")) {
        await bareGit.raw(["worktree", "add", absoluteWorktreePath, branchName]);

        const worktreeGit = this.isLfsSkipEnabled()
          ? simpleGit(absoluteWorktreePath).env({ GIT_LFS_SKIP_SMUDGE: "1" })
          : simpleGit(absoluteWorktreePath);
        await worktreeGit.branch(["--set-upstream-to", `origin/${branchName}`, branchName]);
      } else {
        // Create new branch tracking the remote branch
        await bareGit.raw([
          "worktree",
          "add",
          "--track",
          "-b",
          branchName,
          absoluteWorktreePath,
          `origin/${branchName}`,
        ]);
      }

      console.log(`  - Created worktree for '${branchName}' with tracking to origin/${branchName}`);

      // Verify LFS files are properly downloaded (if not skipping LFS)
      if (!this.isLfsSkipEnabled()) {
        await this.verifyLfsFilesDownloaded(absoluteWorktreePath, branchName);
      }

      // Create metadata for the new worktree
      await this.createWorktreeMetadata(bareGit, absoluteWorktreePath, branchName);
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      // Re-throw metadata creation errors - these are fatal and should not fall back
      if (errorMessage.includes("Metadata creation failed")) {
        throw error;
      }

      // Check if this is an "already registered" error
      if (errorMessage.includes("already registered worktree")) {
        // Check if worktree was actually created by a concurrent operation
        const worktrees = await this.getWorktreesFromBare(bareGit);
        const alreadyExists = worktrees.some((w) => path.resolve(w.path) === absoluteWorktreePath);

        if (alreadyExists) {
          console.log(`  - Worktree for '${branchName}' was created by concurrent operation`);
          return;
        }

        console.warn(`  - Worktree already registered but missing. Pruning and retrying...`);
        await bareGit.raw(["worktree", "prune"]);
        // Clean up directory if it exists
        try {
          await fs.rm(absoluteWorktreePath, { recursive: true, force: true });
        } catch {
          // Directory might not exist, ignore
        }
        // Retry once after pruning
        try {
          await bareGit.raw([
            "worktree",
            "add",
            "--track",
            "-b",
            branchName,
            absoluteWorktreePath,
            `origin/${branchName}`,
          ]);
          console.log(`  - Created worktree for '${branchName}' after pruning`);

          // Verify LFS files are properly downloaded (if not skipping LFS)
          if (!this.isLfsSkipEnabled()) {
            await this.verifyLfsFilesDownloaded(absoluteWorktreePath, branchName);
          }

          await this.createWorktreeMetadata(bareGit, absoluteWorktreePath, branchName);
          return;
        } catch (retryError) {
          console.error(`  - Failed to create worktree after pruning: ${retryError}`);
          throw retryError;
        }
      }

      // If the worktree add fails with tracking, fall back to non-tracking version
      // This handles edge cases where the remote branch might not exist yet
      console.warn(`  - Failed to create worktree with tracking, falling back to simple add: ${error}`);

      // Check again if directory exists before fallback attempt
      try {
        await fs.access(absoluteWorktreePath);
        // Directory exists - check if it's already a valid worktree
        const worktrees = await this.getWorktreesFromBare(bareGit);
        const isValidWorktree = worktrees.some((w) => path.resolve(w.path) === absoluteWorktreePath);

        if (isValidWorktree) {
          console.log(`  - Worktree for '${branchName}' already exists at '${absoluteWorktreePath}'`);
          return;
        } else {
          // Directory exists but is not a valid worktree - clean it up
          console.log(`  - Cleaning up orphaned directory at '${absoluteWorktreePath}' before fallback attempt`);
          await fs.rm(absoluteWorktreePath, { recursive: true, force: true });
        }
      } catch {
        // Directory doesn't exist, which is expected - continue with fallback
      }

      try {
        await bareGit.raw(["worktree", "add", absoluteWorktreePath, branchName]);
        console.log(`  - Created worktree for '${branchName}' (without tracking)`);

        // Verify LFS files are properly downloaded (if not skipping LFS)
        if (!this.isLfsSkipEnabled()) {
          await this.verifyLfsFilesDownloaded(absoluteWorktreePath, branchName);
        }

        // Try to create metadata even without tracking
        await this.createWorktreeMetadata(bareGit, absoluteWorktreePath, branchName);
      } catch (fallbackError) {
        const fallbackErrorMessage = getErrorMessage(fallbackError);

        // If fallback also fails with "already registered", check if created by concurrent op
        if (fallbackErrorMessage.includes("already registered worktree")) {
          const worktrees = await this.getWorktreesFromBare(bareGit);
          const alreadyExists = worktrees.some((w) => path.resolve(w.path) === absoluteWorktreePath);

          if (alreadyExists) {
            console.log(`  - Worktree for '${branchName}' was created by concurrent operation during fallback`);
            return;
          }
        }

        // If still failing, this is a real error
        throw fallbackError;
      }
    }
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    const bareGit = simpleGit(this.bareRepoPath);

    await bareGit.raw(["worktree", "remove", worktreePath, "--force"]);
    console.log(`  - ✅ Safely removed stale worktree at '${worktreePath}'.`);

    // Clean up metadata using the worktree path
    try {
      await this.metadataService.deleteMetadataFromPath(this.bareRepoPath, worktreePath);
    } catch (metadataError) {
      console.warn(`Failed to delete metadata for worktree: ${metadataError}`);
    }
  }

  async pruneWorktrees(): Promise<void> {
    const bareGit = simpleGit(this.bareRepoPath);
    await bareGit.raw(["worktree", "prune"]);
    console.log("Pruned worktree metadata.");
  }

  async checkWorktreeStatus(worktreePath: string): Promise<boolean> {
    const worktreeGit = simpleGit(worktreePath);
    const status = await worktreeGit.status();
    return status.isClean();
  }

  private async isDetachedHead(worktreeGit: SimpleGit): Promise<boolean> {
    try {
      const branchSummary = await worktreeGit.branch();
      return !branchSummary.current || branchSummary.detached;
    } catch {
      return true;
    }
  }

  async hasUnpushedCommits(worktreePath: string): Promise<boolean> {
    const worktreeGit = simpleGit(worktreePath);
    try {
      // Check if in detached HEAD state
      if (await this.isDetachedHead(worktreeGit)) {
        return false;
      }

      // Get the current branch name
      const branchSummary = await worktreeGit.branch();
      const currentBranch = branchSummary.current;

      // Check if upstream is gone
      const upstreamGone = await this.hasUpstreamGone(worktreePath);
      if (upstreamGone) {
        // Load metadata to check for commits after last sync (use path-based method)
        const metadata = await this.metadataService.loadMetadataFromPath(this.bareRepoPath, worktreePath);
        if (metadata?.lastSyncCommit) {
          try {
            // Check for commits after last sync
            const newCommitsResult = await worktreeGit.raw(["rev-list", "--count", `${metadata.lastSyncCommit}..HEAD`]);
            const newCommitsCount = parseInt(newCommitsResult.trim(), 10);
            return newCommitsCount > 0;
          } catch {
            // If lastSyncCommit doesn't exist, fall through to regular check
          }
        }
      }

      // Count commits that exist in the current branch but not in any remote
      const result = await worktreeGit.raw(["rev-list", "--count", currentBranch, "--not", "--remotes"]);

      const unpushedCount = parseInt(result.trim(), 10);
      return unpushedCount > 0;
    } catch (error) {
      // If the command fails (e.g., branch doesn't exist), assume it's safe
      console.error(`Error checking unpushed commits: ${error}`);
      return false;
    }
  }

  async hasUpstreamGone(worktreePath: string): Promise<boolean> {
    const worktreeGit = simpleGit(worktreePath);
    try {
      // Check if in detached HEAD state
      if (await this.isDetachedHead(worktreeGit)) {
        return false;
      }

      const branchSummary = await worktreeGit.branch();
      const currentBranch = branchSummary.current;

      // Try to get upstream branch
      const upstream = await worktreeGit.raw(["rev-parse", "--abbrev-ref", `${currentBranch}@{upstream}`]);

      // Check if upstream exists in remotes
      const remoteBranches = await worktreeGit.branch(["-r"]);
      return !remoteBranches.all.includes(upstream.trim());
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      if (
        errorMessage.includes("fatal: no upstream configured") ||
        errorMessage.includes("no upstream configured for branch")
      ) {
        return false;
      }

      if (errorMessage.includes("fatal: ambiguous argument") || errorMessage.includes("unknown revision or path")) {
        try {
          const branchSummary = await worktreeGit.branch();
          const currentBranch = branchSummary.current;

          const remoteResult = await worktreeGit
            .raw(["config", "--get", `branch.${currentBranch}.remote`])
            .catch(() => "");
          const mergeResult = await worktreeGit
            .raw(["config", "--get", `branch.${currentBranch}.merge`])
            .catch(() => "");

          const remote = remoteResult.trim();
          const merge = mergeResult.trim();

          if (remote && merge) {
            const remoteBranchName = merge.replace("refs/heads/", "");
            const expectedUpstream = `${remote}/${remoteBranchName}`;

            const remoteBranches = await worktreeGit.branch(["-r"]);
            return !remoteBranches.all.includes(expectedUpstream);
          }
        } catch {
          // Can't determine config, be conservative
        }

        return false;
      }

      console.error(
        `Unexpected error checking upstream status for ${worktreePath}. ` +
          `This might indicate a real issue rather than a missing upstream. ` +
          `Error: ${errorMessage}`,
      );

      return false;
    }
  }

  async hasStashedChanges(worktreePath: string): Promise<boolean> {
    const worktreeGit = simpleGit(worktreePath);
    try {
      const stashList = await worktreeGit.stashList();
      return stashList.total > 0;
    } catch (error) {
      // If stash check fails, assume it's unsafe to delete
      console.error(`Error checking stash: ${error}`);
      return true;
    }
  }

  async getFullWorktreeStatus(worktreePath: string, includeDetails = false): Promise<WorktreeStatusResult> {
    const metadata = await this.metadataService.loadMetadataFromPath(this.bareRepoPath, worktreePath);
    return this.statusService.getFullWorktreeStatus(worktreePath, includeDetails, metadata?.lastSyncCommit);
  }

  async hasModifiedSubmodules(worktreePath: string): Promise<boolean> {
    const worktreeGit = simpleGit(worktreePath);
    try {
      const result = await worktreeGit.raw(["submodule", "status"]);
      // Check for '+' or '-' prefix indicating modifications
      return /^[+-]/m.test(result);
    } catch {
      return false; // No submodules or submodule command failed
    }
  }

  async hasOperationInProgress(worktreePath: string): Promise<boolean> {
    // Resolve the actual git directory; in worktrees .git is a file pointing to the real gitdir
    let resolvedGitDir = path.join(worktreePath, ".git");
    try {
      const stat = await fs.stat(resolvedGitDir);
      if (stat.isFile()) {
        const content = await fs.readFile(resolvedGitDir, "utf-8");
        const match = content.match(/gitdir:\s*(.*)/i);
        if (match && match[1]) {
          resolvedGitDir = match[1].trim();
          if (!path.isAbsolute(resolvedGitDir)) {
            resolvedGitDir = path.resolve(worktreePath, resolvedGitDir);
          }
        }
      }
    } catch {
      // Fall back to default .git directory
    }

    const checkFiles = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"];
    for (const file of checkFiles) {
      try {
        await fs.access(path.join(resolvedGitDir, file));
        return true; // Operation in progress
      } catch {
        // File doesn't exist, continue checking
      }
    }
    return false;
  }

  async getCurrentBranch(): Promise<string> {
    const git = this.getGit();
    const branchSummary = await git.branch();
    return branchSummary.current;
  }

  private async detectDefaultBranch(bareGit: SimpleGit): Promise<string> {
    try {
      // Try to get the symbolic ref for origin/HEAD
      const headRef = await bareGit.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
      // Extract branch name from refs/remotes/origin/main or refs/remotes/origin/master
      const branch = headRef.trim().split("/").pop();
      if (branch) {
        return branch;
      }
    } catch {
      // If that fails, try to set HEAD automatically
      try {
        await bareGit.raw(["remote", "set-head", "origin", "-a"]);
        const headRef = await bareGit.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
        const branch = headRef.trim().split("/").pop();
        if (branch) {
          return branch;
        }
      } catch {
        // If all else fails, try to detect from remote branches
        try {
          const remoteBranches = await bareGit.branch(["-r"]);
          // Common default branch names in order of preference
          const commonDefaults = ["main", "master", "develop", "trunk"];
          for (const defaultName of commonDefaults) {
            if (remoteBranches.all.some((branch) => branch === `origin/${defaultName}`)) {
              return defaultName;
            }
          }
        } catch {
          // Ignore and fall through to default
        }
      }
    }
    // Final fallback
    return "main";
  }

  private isLfsSkipEnabled(): boolean {
    return this.config.skipLfs || process.env.GIT_LFS_SKIP_SMUDGE === "1";
  }

  async getWorktrees(): Promise<{ path: string; branch: string }[]> {
    const bareGit = simpleGit(this.bareRepoPath);
    return this.getWorktreesFromBare(bareGit);
  }

  async isWorktreeBehind(worktreePath: string): Promise<boolean> {
    const worktreeGit = simpleGit(worktreePath);
    try {
      // Get the current branch
      const branchSummary = await worktreeGit.branch();
      const currentBranch = branchSummary.current;

      // Check if the branch has an upstream
      const upstreamInfo = await worktreeGit.raw(["rev-parse", "--abbrev-ref", `${currentBranch}@{upstream}`]);
      if (!upstreamInfo.trim()) {
        return false; // No upstream, can't be behind
      }

      // Count commits behind upstream
      const behindCount = await worktreeGit.raw(["rev-list", "--count", `HEAD..${upstreamInfo.trim()}`]);
      return parseInt(behindCount.trim(), 10) > 0;
    } catch {
      // If any command fails, assume not behind
      return false;
    }
  }

  async updateWorktree(worktreePath: string): Promise<void> {
    const worktreeGit = this.isLfsSkipEnabled()
      ? simpleGit(worktreePath).env({ GIT_LFS_SKIP_SMUDGE: "1" })
      : simpleGit(worktreePath);

    // Perform a fast-forward merge
    const branchSummary = await worktreeGit.branch();
    const currentBranch = branchSummary.current;

    await worktreeGit.merge([`origin/${currentBranch}`, "--ff-only"]);

    // Skip metadata update for main worktree
    const isMainWorktree = path.resolve(worktreePath) === path.resolve(this.mainWorktreePath);
    if (isMainWorktree) {
      return;
    }

    // Update metadata after successful update (use path-based method)
    try {
      const currentCommit = await worktreeGit.revparse(["HEAD"]);
      await this.metadataService.updateLastSyncFromPath(
        this.bareRepoPath,
        worktreePath,
        currentCommit.trim(),
        "updated",
        this.defaultBranch,
      );
    } catch (metadataError) {
      console.warn(`Failed to update metadata for worktree: ${metadataError}`);
    }
  }

  async hasDivergedHistory(worktreePath: string, expectedBranch: string): Promise<boolean> {
    const worktreeGit = simpleGit(worktreePath);

    // Validate branch matches
    const branchInfo = await worktreeGit.branch();
    if (branchInfo.current !== expectedBranch) {
      console.warn(`Branch mismatch in hasDivergedHistory: expected ${expectedBranch}, got ${branchInfo.current}`);
      return false; // Conservative: assume can fast-forward
    }

    try {
      // Check if HEAD is an ancestor of the remote branch (can fast-forward)
      await worktreeGit.raw(["merge-base", "--is-ancestor", "HEAD", `origin/${expectedBranch}`]);
      return false; // Can fast-forward
    } catch {
      return true; // Histories have diverged
    }
  }

  async canFastForward(worktreePath: string, branch: string): Promise<boolean> {
    const worktreeGit = simpleGit(worktreePath);
    try {
      // Get the merge base between HEAD and the remote branch
      const mergeBase = await worktreeGit.raw(["merge-base", "HEAD", `origin/${branch}`]);
      const mergeBaseSha = mergeBase.trim();

      // Get current HEAD SHA
      const headSha = await worktreeGit.revparse(["HEAD"]);
      const headShaTrimmed = headSha.trim();

      // If merge base equals HEAD, then HEAD is an ancestor of remote and can fast-forward
      return mergeBaseSha === headShaTrimmed;
    } catch {
      // If merge-base fails, branches have diverged
      return false;
    }
  }

  async compareTreeContent(worktreePath: string, branch: string): Promise<boolean> {
    const worktreeGit = simpleGit(worktreePath);
    try {
      // Get the tree SHA for the current HEAD
      const localTree = await worktreeGit.raw(["rev-parse", "HEAD^{tree}"]);
      // Get the tree SHA for the remote branch
      const remoteTree = await worktreeGit.raw(["rev-parse", `origin/${branch}^{tree}`]);

      return localTree.trim() === remoteTree.trim();
    } catch (error) {
      console.error(`Error comparing tree content: ${error}`);
      return false; // Assume trees are different if we can't compare
    }
  }

  async resetToUpstream(worktreePath: string, branch: string): Promise<void> {
    const worktreeGit = this.isLfsSkipEnabled()
      ? simpleGit(worktreePath).env({ GIT_LFS_SKIP_SMUDGE: "1" })
      : simpleGit(worktreePath);

    await worktreeGit.reset(["--hard", `origin/${branch}`]);

    // Update metadata after reset (use path-based method)
    try {
      const currentCommit = await worktreeGit.revparse(["HEAD"]);
      await this.metadataService.updateLastSyncFromPath(
        this.bareRepoPath,
        worktreePath,
        currentCommit.trim(),
        "updated",
        this.defaultBranch,
      );
    } catch (metadataError) {
      console.warn(`Failed to update metadata after reset: ${metadataError}`);
    }
  }

  async getCurrentCommit(worktreePath: string): Promise<string> {
    const worktreeGit = simpleGit(worktreePath);
    const commit = await worktreeGit.revparse(["HEAD"]);
    return commit.trim();
  }

  async getRemoteCommit(ref: string): Promise<string> {
    // Use the bare repository to read remote commit to avoid dependency on main worktree path
    const git = simpleGit(this.bareRepoPath);
    const commit = await git.revparse([ref]);
    return commit.trim();
  }

  async getWorktreeMetadata(worktreePath: string): Promise<SyncMetadata | null> {
    return this.metadataService.loadMetadataFromPath(this.bareRepoPath, worktreePath);
  }

  private async getWorktreesFromBare(bareGit: SimpleGit): Promise<{ path: string; branch: string }[]> {
    const result = await bareGit.raw(["worktree", "list", "--porcelain"]);

    const worktrees: { path: string; branch: string }[] = [];
    const lines = result.trim().split("\n");

    let currentWorktree: { path?: string; branch?: string; detached?: boolean } = {};

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        currentWorktree.path = line.substring(9);
      } else if (line.startsWith("branch ")) {
        currentWorktree.branch = line.substring(7).replace("refs/heads/", "");
      } else if (line === "detached") {
        currentWorktree.detached = true;
      } else if (line.trim() === "") {
        if (currentWorktree.path) {
          // Only include worktrees that have a branch (not detached)
          if (currentWorktree.branch && !currentWorktree.detached) {
            worktrees.push({ path: currentWorktree.path, branch: currentWorktree.branch });
          }
        }
        currentWorktree = {};
      }
    }

    // Handle the last worktree if there's no trailing empty line
    if (currentWorktree.path && currentWorktree.branch && !currentWorktree.detached) {
      worktrees.push({ path: currentWorktree.path, branch: currentWorktree.branch });
    }

    return worktrees;
  }
}
