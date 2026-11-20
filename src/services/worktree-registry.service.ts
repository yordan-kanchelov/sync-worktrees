import { WorktreeNotCleanError } from "../errors";
import { getErrorMessage } from "../utils/errors";
import { findByWorktreePath } from "../utils/path-compare";
import { parseWorktreeListPorcelain, readWorktreeListPorcelain } from "../utils/worktree-list-parser";

import type { GitServiceContext, RegisteredWorktree } from "./git-service.types";
import type { Logger } from "./logger.service";
import type { WorktreeMetadataService } from "./worktree-metadata.service";
import type { SimpleGit } from "simple-git";

export class WorktreeRegistryService {
  constructor(
    private readonly ctx: GitServiceContext,
    private readonly metadataService: WorktreeMetadataService,
  ) {}

  private get logger(): Logger {
    return this.ctx.logger();
  }

  async getWorktrees(options: { includeDetached?: boolean } = {}): Promise<RegisteredWorktree[]> {
    const bareGit = this.ctx.localGit(this.ctx.bareRepoPath);
    if (options.includeDetached !== true) return this.getWorktreesFromBare(bareGit);
    const worktrees = await this.getWorktreesFromBare(bareGit, true);
    return worktrees.filter(
      (worktree) => worktree.branch !== "" || (worktree.detached === true && worktree.isPrunable !== true),
    );
  }

  async getWorktreeLock(worktreePath: string): Promise<{ locked: boolean; reason?: string }> {
    const bareGit = this.ctx.localGit(this.ctx.bareRepoPath);
    let worktrees: RegisteredWorktree[];
    try {
      worktrees = await this.getWorktreesFromBare(bareGit, true);
    } catch (error) {
      this.logger.warn(`Could not read worktree lock state for '${worktreePath}': ${getErrorMessage(error)}`);
      return { locked: false };
    }

    const registered = await findByWorktreePath(worktrees, worktreePath);
    if (!registered?.locked) return { locked: false };
    return { locked: true, ...(registered.lockReason !== undefined && { reason: registered.lockReason }) };
  }

  async isRegisteredWorktree(bareGit: SimpleGit, worktreePath: string): Promise<boolean> {
    const worktrees = await this.getWorktreesFromBare(bareGit, true);
    return (
      (await findByWorktreePath(
        worktrees.filter((w) => !w.isPrunable),
        worktreePath,
      )) !== undefined
    );
  }

  async getWorktreesFromBare(bareGit: SimpleGit, includeDetached = false): Promise<RegisteredWorktree[]> {
    const result = await readWorktreeListPorcelain(bareGit);
    return parseWorktreeListPorcelain(result)
      .filter((w) => includeDetached || (!w.detached && w.branch !== null))
      .map((w) => ({
        path: w.path,
        branch: w.branch ?? "",
        isPrunable: w.prunable,
        locked: w.locked,
        ...(w.lockReason !== null && { lockReason: w.lockReason }),
        ...(w.detached && { detached: true }),
        ...(w.head !== null && { head: w.head }),
      }));
  }

  private static isRemovalRefusal(message: string, forced: boolean): boolean {
    if (/locked working tree/i.test(message)) return true;
    return !forced && /contains modified or untracked files|use --force|containing submodules/i.test(message);
  }

  async removeWorktree(worktreePath: string, options?: { force?: boolean }): Promise<void> {
    const bareGit = this.ctx.localGit(this.ctx.bareRepoPath);

    const args = ["worktree", "remove", worktreePath];
    if (options?.force) args.push("--force");

    try {
      await bareGit.raw(args);
    } catch (error) {
      const message = getErrorMessage(error);
      if (WorktreeRegistryService.isRemovalRefusal(message, options?.force ?? false)) {
        throw new WorktreeNotCleanError(worktreePath, [`git refused removal: ${message}`]);
      }
      throw error;
    }
    this.ctx.forgetCachedClients(worktreePath);
    this.logger.info(`  - ✅ Safely removed stale worktree at '${worktreePath}'.`);

    try {
      await this.metadataService.deleteMetadataFromPath(this.ctx.bareRepoPath, worktreePath);
    } catch (metadataError) {
      this.logger.warn(`Failed to delete metadata for worktree: ${String(metadataError)}`);
    }
  }
}
