import * as fs from "fs/promises";

import simpleGit from "simple-git";

import type { Config } from "../types";
import type { SimpleGit } from "simple-git";

export class GitService {
  private git: SimpleGit | null = null;

  constructor(private config: Config) {}

  async initialize(): Promise<SimpleGit> {
    const { repoPath, repoUrl } = this.config;

    try {
      await fs.access(repoPath);
      console.log(`Repository path at "${repoPath}" already exists. Using it.`);
      this.git = simpleGit(repoPath);
      return this.git;
    } catch {
      if (!repoUrl) {
        throw new Error(`Repo path "${repoPath}" not found and no --repoUrl was provided to clone from.`);
      }

      console.log(`Cloning from "${repoUrl}" into "${repoPath}"...`);
      await simpleGit().clone(repoUrl, repoPath);
      console.log("✅ Clone successful.");
      this.git = simpleGit(repoPath);
      return this.git;
    }
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
    const git = this.getGit();
    await git.raw(["worktree", "add", worktreePath, branchName]);
    console.log(`  - Created worktree for '${branchName}'`);
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    const git = this.getGit();
    await git.raw(["worktree", "remove", worktreePath, "--force"]);
    console.log(`  - ✅ Safely removed stale worktree at '${worktreePath}'.`);
  }

  async pruneWorktrees(): Promise<void> {
    const git = this.getGit();
    await git.raw(["worktree", "prune"]);
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
    const git = this.getGit();
    const result = await git.raw(["worktree", "list", "--porcelain"]);

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
