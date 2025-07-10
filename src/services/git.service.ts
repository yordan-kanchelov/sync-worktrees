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

  constructor(private config: Config) {
    this.bareRepoPath = this.config.bareRepoDir || getDefaultBareRepoDir(this.config.repoUrl);
    this.mainWorktreePath = path.join(this.config.worktreeDir, "main");
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
      console.log(`Creating main worktree at "${this.mainWorktreePath}"...`);
      await fs.mkdir(this.config.worktreeDir, { recursive: true });
      // Use absolute path for worktree add to avoid relative path issues
      const absoluteWorktreePath = path.resolve(this.mainWorktreePath);
      await bareGit.raw(["worktree", "add", absoluteWorktreePath, "main"]);
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

  async addWorktree(branchName: string, worktreePath: string): Promise<void> {
    const bareGit = simpleGit(this.bareRepoPath);
    // Use absolute path for worktree add to avoid relative path issues
    const absoluteWorktreePath = path.resolve(worktreePath);
    await bareGit.raw(["worktree", "add", absoluteWorktreePath, branchName]);
    console.log(`  - Created worktree for '${branchName}'`);
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

  async getCurrentBranch(): Promise<string> {
    const git = this.getGit();
    const branchSummary = await git.branch();
    return branchSummary.current;
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
