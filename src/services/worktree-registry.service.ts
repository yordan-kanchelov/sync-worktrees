import * as path from "path";

import { WorktreeNotCleanError } from "../errors";
import { getErrorMessage } from "../utils/errors";
import { parseWorktreeListPorcelain, readWorktreeListPorcelain } from "../utils/worktree-list-parser";

import type { GitServiceContext, RegisteredWorktree } from "./git-service.types";
import type { Logger } from "./logger.service";
import type { WorktreeMetadataService } from "./worktree-metadata.service";
import type { SimpleGit } from "simple-git";

/**
 * The bare repository's worktree registrations: `git worktree list` in the
 * shapes callers need (branch-bearing only, with detached rows, a lock
 * lookup, a registration check) and `git worktree remove`. Part of
 * GitService, which hands it its cached clients through the shared context.
 */
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
    // `includeDetached` is for callers that must *find* a detached worktree
    // (membership, path resolution) rather than act on its branch. Git's
    // listing also opens with the bare repository's own row, which has neither
    // a branch nor a detached HEAD; the default listing drops it along with
    // the detached entries, so drop it here too. Otherwise asking for detached
    // worktrees would quietly hand back a row whose `branch` is the empty
    // string — something a caller could fetch or merge.
    //
    // A prunable detached row is dropped for the same reason the rest of this
    // service treats a prunable registration as absent (isRegisteredWorktree):
    // the checkout is gone, so `detached` there describes an admin file rather
    // than a working tree, and a caller told "detached HEAD, check out a
    // branch" would be sent to a directory that does not exist. Branch-bearing
    // prunable rows are left exactly as they were: the default listing has
    // always returned them, and nothing here changes that.
    const worktrees = await this.getWorktreesFromBare(bareGit, true);
    return worktrees.filter(
      (worktree) => worktree.branch !== "" || (worktree.detached === true && worktree.isPrunable !== true),
    );
  }

  // Whether git holds a lock on the registration covering `worktreePath` — a
  // worktree the user asked git to protect, which `worktree remove` refuses
  // while the lock stands. Callers use it to leave such a worktree alone
  // before they move anything. An unregistered path, a detached-HEAD sibling
  // and an unreadable listing all answer "not locked": the caller's own
  // removal reports the real problem, and blocking on a failed listing would
  // stop removals git would happily perform.
  async getWorktreeLock(worktreePath: string): Promise<{ locked: boolean; reason?: string }> {
    const bareGit = this.ctx.localGit(this.ctx.bareRepoPath);
    let worktrees: RegisteredWorktree[];
    try {
      worktrees = await this.getWorktreesFromBare(bareGit, true);
    } catch (error) {
      this.logger.warn(`Could not read worktree lock state for '${worktreePath}': ${getErrorMessage(error)}`);
      return { locked: false };
    }

    const target = path.resolve(worktreePath);
    const registered = worktrees.find((worktree) => path.resolve(worktree.path) === target);
    if (!registered?.locked) return { locked: false };
    return { locked: true, ...(registered.lockReason !== undefined && { reason: registered.lockReason }) };
  }

  async isRegisteredWorktree(bareGit: SimpleGit, worktreePath: string): Promise<boolean> {
    const absoluteWorktreePath = path.resolve(worktreePath);
    const worktrees = await this.getWorktreesFromBare(bareGit, true);
    return worktrees.some((w) => path.resolve(w.path) === absoluteWorktreePath && !w.isPrunable);
  }

  // `bareGit` is the caller's client for the bare repository: worktree
  // creation lists through its LFS-aware one, everything else through the
  // plain one.
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
        // Only set when true: a listing that excludes detached entries would
        // otherwise carry a `detached: false` on every worktree it returns.
        ...(w.detached && { detached: true }),
        ...(w.head !== null && { head: w.head }),
      }));
  }

  // `git worktree remove` refuses three ways, and none of them means the
  // repository is broken — they are git protecting user state, so callers see a
  // skip-shaped WorktreeNotCleanError instead of a hard failure:
  //  - a dirty tree ("contains modified or untracked files", "use --force");
  //  - a worktree the user locked, which git refuses even with a single
  //    --force ("cannot remove a locked working tree ... use 'remove -f -f'").
  //    We never pass -f -f: force-unlocking a worktree somebody deliberately
  //    locked is exactly what the lock exists to prevent;
  //  - without --force, a worktree holding initialized submodules ("working
  //    trees containing submodules cannot be moved or removed").
  private static isRemovalRefusal(message: string, forced: boolean): boolean {
    if (/locked working tree/i.test(message)) return true;
    return !forced && /contains modified or untracked files|use --force|containing submodules/i.test(message);
  }

  async removeWorktree(worktreePath: string, options?: { force?: boolean }): Promise<void> {
    const bareGit = this.ctx.localGit(this.ctx.bareRepoPath);

    // Non-forced by default: git's own refusal to delete a dirty worktree is
    // the last line of defense when our status checks were wrong. --force is
    // reserved for callers that already preserved the data (diverged flow) or
    // explicit user override.
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

    // Clean up metadata using the worktree path
    try {
      await this.metadataService.deleteMetadataFromPath(this.ctx.bareRepoPath, worktreePath);
    } catch (metadataError) {
      this.logger.warn(`Failed to delete metadata for worktree: ${String(metadataError)}`);
    }
  }
}
