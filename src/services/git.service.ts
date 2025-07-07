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

  async removeWorktree(branchName: string): Promise<void> {
    const git = this.getGit();
    await git.raw(["worktree", "remove", branchName, "--force"]);
    console.log(`  - ✅ Safely removed stale worktree for '${branchName}'.`);
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
}
