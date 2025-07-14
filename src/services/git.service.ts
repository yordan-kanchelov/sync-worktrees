import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";

import { getDefaultBareRepoDir } from "../utils/git-url";

import { WorktreeMetadataService } from "./worktree-metadata.service";

import type { Config } from "../types";
import type { SimpleGit } from "simple-git";

export class GitService {
  private git: SimpleGit | null = null;
  private bareRepoPath: string;
  private mainWorktreePath: string;
  private defaultBranch: string = "main"; // Will be updated after detection
  private metadataService: WorktreeMetadataService;

  constructor(private config: Config) {
    this.bareRepoPath = this.config.bareRepoDir || getDefaultBareRepoDir(this.config.repoUrl);
    this.mainWorktreePath = path.join(this.config.worktreeDir, "main"); // Temporary, will be updated
    this.metadataService = new WorktreeMetadataService();
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
    if (this.isLfsSkipEnabled()) {
      await bareGit.env({ GIT_LFS_SKIP_SMUDGE: "1" }).fetch(["--all"]);
    } else {
      await bareGit.fetch(["--all"]);
    }

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
          if (this.isLfsSkipEnabled()) {
            await bareGit
              .env({ GIT_LFS_SKIP_SMUDGE: "1" })
              .raw(["worktree", "add", absoluteWorktreePath, this.defaultBranch]);
          } else {
            await bareGit.raw(["worktree", "add", absoluteWorktreePath, this.defaultBranch]);
          }
          // Set upstream tracking after creating worktree
          const worktreeGit = this.isLfsSkipEnabled()
            ? simpleGit(absoluteWorktreePath).env({ GIT_LFS_SKIP_SMUDGE: "1" })
            : simpleGit(absoluteWorktreePath);
          await worktreeGit.branch(["--set-upstream-to", `origin/${this.defaultBranch}`, this.defaultBranch]);
        } else {
          // Create new branch tracking the remote branch
          if (this.isLfsSkipEnabled()) {
            await bareGit
              .env({ GIT_LFS_SKIP_SMUDGE: "1" })
              .raw([
                "worktree",
                "add",
                "--track",
                "-b",
                this.defaultBranch,
                absoluteWorktreePath,
                `origin/${this.defaultBranch}`,
              ]);
          } else {
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
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // Check if error is because directory already exists
        if (errorMessage.includes("already exists")) {
          console.log(
            `${this.defaultBranch} worktree directory already exists at '${absoluteWorktreePath}', skipping creation.`,
          );
        } else {
          // Fallback to simple add if tracking setup fails
          console.warn(`Failed to create ${this.defaultBranch} worktree with tracking, using simple add: ${error}`);
          try {
            if (this.isLfsSkipEnabled()) {
              await bareGit
                .env({ GIT_LFS_SKIP_SMUDGE: "1" })
                .raw(["worktree", "add", absoluteWorktreePath, this.defaultBranch]);
            } else {
              await bareGit.raw(["worktree", "add", absoluteWorktreePath, this.defaultBranch]);
            }
          } catch (fallbackError) {
            const fallbackErrorMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
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

    if (this.isLfsSkipEnabled()) {
      await git.env({ GIT_LFS_SKIP_SMUDGE: "1" }).fetch(["origin", `${branchName}:${branchName}`, "--prune"]);
    } else {
      await git.fetch(["origin", `${branchName}:${branchName}`, "--prune"]);
    }
  }

  async getRemoteBranches(): Promise<string[]> {
    const git = this.getGit();
    const branches = await git.branch(["-r"]);
    return branches.all
      .filter((b) => b.startsWith("origin/") && !b.endsWith("/HEAD"))
      .map((b) => b.replace("origin/", ""));
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
        const lastActivity = new Date(dateStr);
        // Skip if the date is invalid
        if (!isNaN(lastActivity.getTime())) {
          branches.push({ branch, lastActivity });
        }
      }
    }

    return branches;
  }

  private async createWorktreeMetadata(bareGit: SimpleGit, worktreePath: string, branchName: string): Promise<void> {
    try {
      const worktreeGit = this.isLfsSkipEnabled()
        ? simpleGit(worktreePath).env({ GIT_LFS_SKIP_SMUDGE: "1" })
        : simpleGit(worktreePath);
      const currentCommit = await worktreeGit.revparse(["HEAD"]);
      const parentCommit = await bareGit.revparse([this.defaultBranch]);

      await this.metadataService.createInitialMetadata(
        this.bareRepoPath,
        branchName,
        currentCommit.trim(),
        `origin/${branchName}`,
        this.defaultBranch,
        parentCommit.trim(),
      );
    } catch (metadataError) {
      console.warn(`  - Failed to create metadata for worktree: ${metadataError}`);
    }
  }

  async addWorktree(branchName: string, worktreePath: string): Promise<void> {
    const bareGit = this.isLfsSkipEnabled()
      ? simpleGit(this.bareRepoPath).env({ GIT_LFS_SKIP_SMUDGE: "1" })
      : simpleGit(this.bareRepoPath);
    // Use absolute path for worktree add to avoid relative path issues
    const absoluteWorktreePath = path.resolve(worktreePath);

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

      if (localBranchExists) {
        // If local branch exists, just add worktree with existing branch
        await bareGit.raw(["worktree", "add", absoluteWorktreePath, branchName]);

        // Set upstream tracking after creating worktree
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

      // Create metadata for the new worktree
      await this.createWorktreeMetadata(bareGit, absoluteWorktreePath, branchName);
    } catch (error) {
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

      await bareGit.raw(["worktree", "add", absoluteWorktreePath, branchName]);
      console.log(`  - Created worktree for '${branchName}' (without tracking)`);

      // Try to create metadata even without tracking
      await this.createWorktreeMetadata(bareGit, absoluteWorktreePath, branchName);
    }
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    const bareGit = simpleGit(this.bareRepoPath);

    // Try to get branch name before removing worktree
    let branchName: string | null = null;
    try {
      const worktrees = await this.getWorktreesFromBare(bareGit);
      const worktree = worktrees.find((w) => path.resolve(w.path) === path.resolve(worktreePath));
      branchName = worktree?.branch || null;
    } catch {
      // If we can't get the branch name, extract from path as fallback
      branchName = path.basename(worktreePath);
    }

    await bareGit.raw(["worktree", "remove", worktreePath, "--force"]);
    console.log(`  - ✅ Safely removed stale worktree at '${worktreePath}'.`);

    // Clean up metadata
    if (branchName) {
      try {
        await this.metadataService.deleteMetadata(this.bareRepoPath, branchName);
      } catch (metadataError) {
        console.warn(`Failed to delete metadata for worktree: ${metadataError}`);
      }
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

  async hasUnpushedCommits(worktreePath: string): Promise<boolean> {
    const worktreeGit = simpleGit(worktreePath);
    try {
      // Get the current branch name
      const branchSummary = await worktreeGit.branch();
      const currentBranch = branchSummary.current;

      // Check if upstream is gone
      const upstreamGone = await this.hasUpstreamGone(worktreePath);
      if (upstreamGone) {
        // Load metadata to check for commits after last sync
        const metadata = await this.metadataService.loadMetadata(this.bareRepoPath, currentBranch);
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
      const branchSummary = await worktreeGit.branch();
      const currentBranch = branchSummary.current;

      // Try to get upstream branch
      const upstream = await worktreeGit.raw(["rev-parse", "--abbrev-ref", `${currentBranch}@{upstream}`]);

      // Check if upstream exists in remotes
      const remoteBranches = await worktreeGit.branch(["-r"]);
      return !remoteBranches.all.includes(upstream.trim());
    } catch (error) {
      // Check if the error is because of no upstream configured
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Match specific Git error messages for missing upstream
      if (
        errorMessage.includes("fatal: no upstream configured") ||
        errorMessage.includes("no upstream configured for branch")
      ) {
        // This is expected when there's no upstream - not an error condition
        return false;
      }

      // Log unexpected errors that don't match known patterns
      console.error(
        `Unexpected error checking upstream status for ${worktreePath}. ` +
          `This might indicate a real issue rather than a missing upstream. ` +
          `Error: ${errorMessage}`,
      );

      // Return false to be safe - we don't want to accidentally delete worktrees
      // due to transient errors
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
    const gitDir = path.join(worktreePath, ".git");
    const checkFiles = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"];

    for (const file of checkFiles) {
      try {
        await fs.access(path.join(gitDir, file));
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

    // Update metadata after successful update
    try {
      const currentCommit = await worktreeGit.revparse(["HEAD"]);
      await this.metadataService.updateLastSync(this.bareRepoPath, currentBranch, currentCommit.trim(), "updated");
    } catch (metadataError) {
      console.warn(`Failed to update metadata for worktree: ${metadataError}`);
    }
  }

  private async getWorktreesFromBare(bareGit: SimpleGit): Promise<{ path: string; branch: string }[]> {
    const result = await bareGit.raw(["worktree", "list", "--porcelain"]);

    const worktrees: { path: string; branch: string }[] = [];
    const lines = result.trim().split("\n");

    let currentWorktree: { path?: string; branch?: string } = {};

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        currentWorktree.path = line.substring(9);
      } else if (line.startsWith("branch ")) {
        currentWorktree.branch = line.substring(7).replace("refs/heads/", "");
      } else if (line.trim() === "") {
        if (currentWorktree.path && currentWorktree.branch) {
          worktrees.push({ path: currentWorktree.path, branch: currentWorktree.branch });
        }
        currentWorktree = {};
      }
    }

    // Handle the last worktree if there's no trailing empty line
    if (currentWorktree.path && currentWorktree.branch) {
      worktrees.push({ path: currentWorktree.path, branch: currentWorktree.branch });
    }

    return worktrees;
  }
}
