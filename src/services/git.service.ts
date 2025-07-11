import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";

import { getDefaultBareRepoDir } from "../utils/git-url";

import type { Config } from "../types";
import type { SimpleGit } from "simple-git";

export class GitService {
  private git: SimpleGit | null = null;
  private bareRepoPath: string;
  private mainWorktreePath: string;
  private defaultBranch: string = "main"; // Will be updated after detection

  constructor(private config: Config) {
    this.bareRepoPath = this.config.bareRepoDir || getDefaultBareRepoDir(this.config.repoUrl);
    this.mainWorktreePath = path.join(this.config.worktreeDir, "main"); // Temporary, will be updated
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
      await simpleGit().clone(repoUrl, this.bareRepoPath, ["--bare"]);
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
      needsMainWorktree = !worktrees.some((w) => w.path === this.mainWorktreePath);
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
          const worktreeGit = simpleGit(absoluteWorktreePath);
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
            await bareGit.raw(["worktree", "add", absoluteWorktreePath, this.defaultBranch]);
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
    await git.fetch(["--all", "--prune"]);
  }

  async getRemoteBranches(): Promise<string[]> {
    const git = this.getGit();
    const branches = await git.branch(["-r"]);
    return branches.all.filter((b) => b.startsWith("origin/")).map((b) => b.replace("origin/", ""));
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
      if (ref && dateStr) {
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

  async addWorktree(branchName: string, worktreePath: string): Promise<void> {
    const bareGit = simpleGit(this.bareRepoPath);
    // Use absolute path for worktree add to avoid relative path issues
    const absoluteWorktreePath = path.resolve(worktreePath);

    try {
      // Check if local branch already exists
      const branches = await bareGit.branch();
      const localBranchExists = branches.all.includes(branchName);

      if (localBranchExists) {
        // If local branch exists, just add worktree with existing branch
        await bareGit.raw(["worktree", "add", absoluteWorktreePath, branchName]);

        // Set upstream tracking after creating worktree
        const worktreeGit = simpleGit(absoluteWorktreePath);
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
    } catch (error) {
      // If the worktree add fails with tracking, fall back to non-tracking version
      // This handles edge cases where the remote branch might not exist yet
      console.warn(`  - Failed to create worktree with tracking, falling back to simple add: ${error}`);
      await bareGit.raw(["worktree", "add", absoluteWorktreePath, branchName]);
      console.log(`  - Created worktree for '${branchName}' (without tracking)`);
    }
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    const bareGit = simpleGit(this.bareRepoPath);
    await bareGit.raw(["worktree", "remove", worktreePath, "--force"]);
    console.log(`  - ✅ Safely removed stale worktree at '${worktreePath}'.`);
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

  async getWorktrees(): Promise<{ path: string; branch: string }[]> {
    const bareGit = simpleGit(this.bareRepoPath);
    return this.getWorktreesFromBare(bareGit);
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
