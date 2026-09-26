import * as fs from "fs/promises";
import * as path from "path";

import { GIT_CONSTANTS, PATH_CONSTANTS } from "../constants";
import { GitOperationError, UpstreamSetupError, WorktreeError, WorktreeMetadataError } from "../errors";
import { getErrorMessage } from "../utils/errors";
import { probePathExists } from "../utils/file-exists";
import { quarantineDirectory } from "../utils/quarantine";

import type { BranchRefService } from "./branch-ref.service";
import type { AddWorktreeResult, GitServiceContext, RegisteredWorktree } from "./git-service.types";
import type { LfsVerificationService } from "./lfs-verification.service";
import type { Logger } from "./logger.service";
import type { SparseCheckoutService } from "./sparse-checkout.service";
import type { WorktreeMetadataService } from "./worktree-metadata.service";
import type { WorktreeRegistryService } from "./worktree-registry.service";
import type { SimpleGit } from "simple-git";

export interface WorktreeCreationDependencies {
  registry: WorktreeRegistryService;
  branchRefs: BranchRefService;
  lfs: LfsVerificationService;
  sparseCheckout: SparseCheckoutService;
  metadata: WorktreeMetadataService;
}

// git's wording when `worktree add` targets a path it already has a
// registration for — live, or left behind by a directory deleted out-of-band.
const ALREADY_REGISTERED_WORKTREE = "already registered worktree";

/**
 * Creates worktrees: the add matrix (local and/or remote branch), sparse
 * setup, the recovery from a stale registration, the no-tracking fallback, the
 * metadata record every managed worktree needs, and the rollback shared by
 * every step that can fail after git registered the worktree. A directory in
 * the way is moved to trash (when enabled) or quarantined, never deleted.
 * Part of GitService, which hands it its cached clients through the shared
 * context.
 */
export class WorktreeCreationService {
  // Injected by WorktreeSyncService when trash is enabled, so stale-directory
  // cleanup follows the same reversible-removal pipeline as everything else.
  // GitService cannot own a TrashService directly (TrashService depends on it).
  private staleDirectoryTrasher: ((dirPath: string) => Promise<string>) | null = null;

  constructor(
    private readonly ctx: GitServiceContext,
    private readonly deps: WorktreeCreationDependencies,
  ) {}

  private get logger(): Logger {
    return this.ctx.logger();
  }

  setStaleDirectoryTrasher(trasher: (dirPath: string) => Promise<string>): void {
    this.staleDirectoryTrasher = trasher;
  }

  // Resolves to what the call did: the HEAD commit of the worktree it created,
  // or `already_registered` when the path already was a registered worktree
  // (one a concurrent operation registered first, or a detached-HEAD checkout
  // someone left there) and nothing was created. Callers that count creations
  // must read `status` rather than assume a create happened.
  async addWorktree(branchName: string, worktreePath: string): Promise<AddWorktreeResult> {
    const bareGit = this.ctx.localGit(this.ctx.bareRepoPath, this.ctx.isLfsSkipEnabled());
    // Use absolute path for worktree add to avoid relative path issues
    const absoluteWorktreePath = path.resolve(worktreePath);
    // Ensure parent directory exists for nested branch paths
    await fs.mkdir(path.dirname(absoluteWorktreePath), { recursive: true });

    // A directory could be left over from a failed previous attempt.
    const alreadyThere = await this.claimWorktreePath(bareGit, absoluteWorktreePath, branchName, "");
    if (alreadyThere) return alreadyThere;

    try {
      return await this.addAndRecord(bareGit, branchName, absoluteWorktreePath, (local, remote) =>
        local && !remote
          ? `  - Created worktree for '${branchName}' (no remote yet — push to set upstream)`
          : `  - Created worktree for '${branchName}' with tracking to origin/${branchName}`,
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      // Upstream setup failures are already rolled back inside runWorktreeAddByMatrix,
      // and metadata failures by createMetadataOrRollback. Both are fatal: the
      // tracking-error fallback below would silently accept a partial worktree.
      if (error instanceof UpstreamSetupError || error instanceof WorktreeMetadataError) {
        throw error;
      }

      if (errorMessage.includes(ALREADY_REGISTERED_WORKTREE)) {
        return this.recoverFromStaleRegistration(bareGit, branchName, absoluteWorktreePath);
      }

      // Only fall back to non-tracking version for tracking-related errors.
      // Re-throw real errors (disk full, permissions, etc.) immediately.
      const isTrackingError =
        errorMessage.includes("not a valid object name") ||
        errorMessage.includes("not a commit") ||
        errorMessage.includes("cannot set up tracking") ||
        errorMessage.includes("does not track") ||
        errorMessage.includes("remote tracking branch") ||
        errorMessage.includes("no such remote ref");

      if (!isTrackingError) {
        throw error;
      }

      this.logger.warn(`  - Failed to create worktree with tracking, falling back to simple add: ${String(error)}`);
      return this.addWithoutTracking(bareGit, branchName, absoluteWorktreePath);
    }
  }

  // What is at the path before an add: resolves to `already_registered` when
  // it is a registered worktree, and to null once the path is free — nothing
  // was there, or the orphaned directory that was has been trashed,
  // quarantined or (when empty) removed. A failure to list worktrees reads as
  // "nothing there" and lets the add report the real problem; a directory that
  // could not be preserved stops the add.
  private async claimWorktreePath(
    bareGit: SimpleGit,
    absoluteWorktreePath: string,
    branchName: string,
    cleanupContext: string,
  ): Promise<AddWorktreeResult | null> {
    try {
      await fs.access(absoluteWorktreePath);
      // Directory exists - check if it's already a valid worktree
      const worktrees = await this.deps.registry.getWorktreesFromBare(bareGit, true);
      const registered = worktrees.find((w) => path.resolve(w.path) === absoluteWorktreePath);

      if (registered) {
        this.logger.info(`  - Worktree for '${branchName}' already exists at '${absoluteWorktreePath}'`);
        return { status: "already_registered", detached: registered.detached === true };
      }
      // Directory exists but is not a valid worktree - clean it up
      this.logger.info(`  - Cleaning up orphaned directory at '${absoluteWorktreePath}'${cleanupContext}`);
      await this.clearStaleWorktreeDirectory(absoluteWorktreePath);
    } catch (error) {
      if (error instanceof GitOperationError || error instanceof WorktreeError) {
        throw error;
      }
      // Directory doesn't exist, which is expected - continue with creation
    }
    return null;
  }

  // The live (non-prunable) registration at the path, if a concurrent
  // operation created the worktree while this add was failing.
  private async findConcurrentRegistration(
    bareGit: SimpleGit,
    absoluteWorktreePath: string,
  ): Promise<RegisteredWorktree | undefined> {
    const worktrees = await this.deps.registry.getWorktreesFromBare(bareGit, true);
    const existingWorktree = worktrees.find((w) => path.resolve(w.path) === absoluteWorktreePath);
    return existingWorktree && !existingWorktree.isPrunable ? existingWorktree : undefined;
  }

  // One pass through the add matrix, then LFS verification and the metadata
  // record (which rolls the worktree back when it cannot be written).
  private async addAndRecord(
    bareGit: SimpleGit,
    branchName: string,
    absoluteWorktreePath: string,
    describeCreation: (localExists: boolean, remoteExists: boolean) => string,
  ): Promise<AddWorktreeResult> {
    const { local: localBranchExists, remote: remoteBranchExists } =
      await this.deps.branchRefs.branchExists(branchName);
    const createdNewBranch = await this.runWorktreeAddByMatrix(
      bareGit,
      branchName,
      absoluteWorktreePath,
      localBranchExists,
      remoteBranchExists,
    );
    this.logger.info(describeCreation(localBranchExists, remoteBranchExists));

    await this.deps.lfs.verifyLfsFilesDownloaded(absoluteWorktreePath, branchName);

    return this.createMetadataOrRollback(bareGit, absoluteWorktreePath, branchName, createdNewBranch);
  }

  // git refused the add because the path is already registered. Either a
  // concurrent operation created the worktree (adopt it), or the registration
  // outlived its directory: drop it, clear whatever is at the path, and add
  // again once.
  private async recoverFromStaleRegistration(
    bareGit: SimpleGit,
    branchName: string,
    absoluteWorktreePath: string,
  ): Promise<AddWorktreeResult> {
    const existingWorktree = await this.findConcurrentRegistration(bareGit, absoluteWorktreePath);
    if (existingWorktree) {
      this.logger.info(`  - Worktree for '${branchName}' was created by concurrent operation`);
      return { status: "already_registered", detached: existingWorktree.detached === true };
    }

    this.logger.warn(`  - Worktree already registered but missing. Removing that registration and retrying...`);
    try {
      await bareGit.raw(["worktree", "remove", "--force", absoluteWorktreePath]);
      this.ctx.forgetCachedClients(absoluteWorktreePath);
    } catch (removalError) {
      this.logger.warn(
        `  - Failed to remove stale registration for '${absoluteWorktreePath}': ${getErrorMessage(removalError)}. Continuing with directory cleanup and retry.`,
      );
    }
    await this.clearStaleWorktreeDirectory(absoluteWorktreePath);
    try {
      return await this.addAndRecord(
        bareGit,
        branchName,
        absoluteWorktreePath,
        () => `  - Created worktree for '${branchName}' on retry`,
      );
    } catch (retryError) {
      this.logger.error(`  - Failed to create worktree on retry: ${String(retryError)}`);
      throw retryError;
    }
  }

  // The add matrix failed on something about tracking: add the branch plainly,
  // then give it an upstream if origin/<branch> exists after all.
  private async addWithoutTracking(
    bareGit: SimpleGit,
    branchName: string,
    absoluteWorktreePath: string,
  ): Promise<AddWorktreeResult> {
    // Check again if directory exists before fallback attempt
    const alreadyThere = await this.claimWorktreePath(
      bareGit,
      absoluteWorktreePath,
      branchName,
      " before fallback attempt",
    );
    if (alreadyThere) return alreadyThere;

    try {
      const useNoCheckout = !!this.ctx.config.sparseCheckout;
      const fallbackArgs = useNoCheckout
        ? ["worktree", "add", "--no-checkout", absoluteWorktreePath, branchName]
        : ["worktree", "add", absoluteWorktreePath, branchName];
      await bareGit.raw(fallbackArgs);
      await this.runSparseStepWithRollback(bareGit, absoluteWorktreePath, branchName, false);
      // The plain add set no upstream; give it one when origin/<branch> exists.
      const tracking = await this.deps.branchRefs.trackRemoteBranchIfExists(branchName, absoluteWorktreePath);
      this.logger.info(`  - Created worktree for '${branchName}'${tracking ? "" : " (without tracking)"}`);

      await this.deps.lfs.verifyLfsFilesDownloaded(absoluteWorktreePath, branchName);

      return await this.createMetadataOrRollback(bareGit, absoluteWorktreePath, branchName, false);
    } catch (fallbackError) {
      // If fallback also fails with "already registered", check if created by concurrent op
      if (getErrorMessage(fallbackError).includes(ALREADY_REGISTERED_WORKTREE)) {
        const existingWorktree = await this.findConcurrentRegistration(bareGit, absoluteWorktreePath);
        if (existingWorktree) {
          this.logger.info(`  - Worktree for '${branchName}' was created by concurrent operation during fallback`);
          return { status: "already_registered", detached: existingWorktree.detached === true };
        }
      }

      // If still failing, this is a real error
      throw fallbackError;
    }
  }

  private async runWorktreeAddByMatrix(
    bareGit: SimpleGit,
    branchName: string,
    absoluteWorktreePath: string,
    localExists: boolean,
    remoteExists: boolean,
  ): Promise<boolean> {
    const useNoCheckout = !!this.ctx.config.sparseCheckout;
    const noCheckoutFlag = useNoCheckout ? ["--no-checkout"] : [];

    if (localExists && remoteExists) {
      // With no worktree for it, the local ref is usually a stale snapshot of
      // the remote — a bare clone's refs/heads/* copy, or the tip a removed
      // worktree was last synced to — that nothing ever fast-forwards. It is
      // probed before the add and fast-forwarded right after, inside the new
      // worktree: `worktree add` keeps its error surface (a missing but still
      // registered path must reach addWorktree's recovery, which a branch
      // reset such as `-B` pre-empts with git's branch-in-use error), and the
      // branch ref only moves once the worktree using it is ours. Commits not
      // on origin/<branch> are kept: a copy whose history was rebased away
      // looks exactly like never-pushed work from here, and only the latter
      // would be lost. The next sync applies its usual update rules then.
      const localOnlyCommits = await this.countLocalOnlyCommits(bareGit, branchName);

      await bareGit.raw(["worktree", "add", ...noCheckoutFlag, absoluteWorktreePath, branchName]);

      // branch --set-upstream-to is a config-only operation and works on a --no-checkout
      // worktree, so we run it before sparse setup and materialization.
      try {
        const worktreeGit = this.ctx.localGit(absoluteWorktreePath, this.ctx.isLfsSkipEnabled());
        await worktreeGit.branch(["--set-upstream-to", `origin/${branchName}`, branchName]);
      } catch (error) {
        throw await this.wrapUpstreamFailure(bareGit, absoluteWorktreePath, branchName, false, error);
      }

      if (localOnlyCommits === 0) {
        await this.fastForwardNewWorktree(absoluteWorktreePath, branchName, useNoCheckout);
      } else {
        this.logger.info(
          localOnlyCommits === null
            ? `  - Could not tell whether local branch '${branchName}' has commits not on origin/${branchName}; keeping its current tip`
            : `  - Local branch '${branchName}' has ${localOnlyCommits} commit(s) not on origin/${branchName}; keeping its current tip instead of resetting it`,
        );
      }

      await this.runSparseStepWithRollback(bareGit, absoluteWorktreePath, branchName, false);
      return false;
    }

    if (localExists) {
      await bareGit.raw(["worktree", "add", ...noCheckoutFlag, absoluteWorktreePath, branchName]);
      await this.runSparseStepWithRollback(bareGit, absoluteWorktreePath, branchName, false);
      return false;
    }

    if (remoteExists) {
      try {
        await bareGit.raw([
          "worktree",
          "add",
          ...noCheckoutFlag,
          "--track",
          "-b",
          branchName,
          absoluteWorktreePath,
          `origin/${branchName}`,
        ]);
      } catch (error) {
        // git creates refs/heads/<branch> before it checks the files out, and
        // it does not undo that when the checkout fails (an LFS smudge filter,
        // a full disk) even though it does clean the worktree up. Left behind,
        // the branch turns every later attempt into the local+remote case,
        // where the add runs against a local ref nothing fast-forwards. Only
        // this call's branch is deleted: `localExists` was false at the probe
        // above, so refs/heads/<branch> can only be the one git just made.
        //
        // Except when the path was already registered: git does create the
        // branch there, but addWorktree's recovery path clears the stale
        // registration and adds again, adopting whatever ref is present, so
        // deleting it here would only fight that retry.
        if (!getErrorMessage(error).includes(ALREADY_REGISTERED_WORKTREE)) {
          await this.deleteBranchLeftByFailedAdd(bareGit, branchName);
        }
        throw error;
      }
      await this.runSparseStepWithRollback(bareGit, absoluteWorktreePath, branchName, true);
      return true;
    }

    throw new WorktreeError(
      `Branch '${branchName}' does not exist locally or on origin; create it first`,
      "BRANCH_NOT_FOUND",
    );
  }

  // Commits on the local branch that origin/<branch> does not reach. Zero
  // means the local tip is an ancestor of (or equal to) the remote tip, so
  // moving it there is a fast-forward that loses nothing. null when git cannot
  // answer, which callers treat as "may have local-only commits".
  private async countLocalOnlyCommits(bareGit: SimpleGit, branchName: string): Promise<number | null> {
    try {
      const out = await bareGit.raw([
        "rev-list",
        "--count",
        `${GIT_CONSTANTS.REFS.REMOTES}/${branchName}..${GIT_CONSTANTS.REFS.HEADS}${branchName}`,
      ]);
      const count = Number.parseInt(out.trim(), 10);
      return Number.isNaN(count) ? null : count;
    } catch {
      return null;
    }
  }

  // Moves a just-created worktree from the local ref's stale tip to
  // origin/<branch>, which countLocalOnlyCommits has shown to be a
  // fast-forward. A checked-out worktree merges; a --no-checkout worktree has
  // no index or files yet, so only the ref moves and the checkout that follows
  // the sparse setup populates it at the new tip. Best-effort: on failure the
  // worktree stays at the local tip — the state the next sync's update phase
  // fast-forwards anyway — and the runner reports the mismatch.
  private async fastForwardNewWorktree(
    absoluteWorktreePath: string,
    branchName: string,
    noCheckout: boolean,
  ): Promise<void> {
    const worktreeGit = this.ctx.localGit(absoluteWorktreePath, this.ctx.isLfsSkipEnabled());
    try {
      if (noCheckout) {
        await worktreeGit.raw(["reset", "--soft", `origin/${branchName}`]);
      } else {
        await worktreeGit.raw(["merge", "--ff-only", `origin/${branchName}`]);
      }
    } catch (error) {
      this.logger.warn(
        `  - ⚠️ Could not fast-forward the new worktree for '${branchName}' to origin/${branchName}: ${getErrorMessage(error)}`,
      );
    }
  }

  // Best-effort rollback of the branch a failed `worktree add --track -b` left
  // behind. Never throws: the add's own error is what the caller must see, and
  // a branch that could not be deleted (a worktree still holds it) is a stale
  // ref, not a broken repository.
  private async deleteBranchLeftByFailedAdd(bareGit: SimpleGit, branchName: string): Promise<void> {
    try {
      if (!(await this.deps.branchRefs.refExists(bareGit, `${GIT_CONSTANTS.REFS.HEADS}${branchName}`))) return;
      // The branch git just created sits at origin/<branch>. Anything ahead of
      // the remote was written by someone else between the probe and the add,
      // and a bare repo keeps no reflog to recover it from.
      if ((await this.countLocalOnlyCommits(bareGit, branchName)) !== 0) {
        this.logger.warn(
          `  - Left the local branch '${branchName}' in place: it carries commits that are not on origin/${branchName}`,
        );
        return;
      }
      await bareGit.raw(["branch", "-D", "--", branchName]);
      this.logger.info(`  - Removed the local branch '${branchName}' left behind by the failed worktree add`);
    } catch (error) {
      this.logger.warn(
        `  - Could not remove the local branch '${branchName}' left behind by the failed worktree add: ${getErrorMessage(error)}`,
      );
    }
  }

  private async applySparseAndCheckout(absoluteWorktreePath: string): Promise<void> {
    if (!this.ctx.config.sparseCheckout) return;
    await this.deps.sparseCheckout.applyToWorktree(absoluteWorktreePath, this.ctx.config.sparseCheckout);
    const worktreeGit = this.ctx.localGit(absoluteWorktreePath, this.ctx.isLfsSkipEnabled());
    await worktreeGit.raw(["checkout", "HEAD"]);
  }

  private async runSparseStepWithRollback(
    bareGit: SimpleGit,
    absoluteWorktreePath: string,
    branchName: string,
    createdNewBranch: boolean,
  ): Promise<void> {
    try {
      await this.applySparseAndCheckout(absoluteWorktreePath);
    } catch (sparseError) {
      await this.rollbackPartialWorktree(bareGit, absoluteWorktreePath, branchName, createdNewBranch);
      throw new Error(`Sparse-checkout setup failed for '${branchName}': ${getErrorMessage(sparseError)}`);
    }
  }

  private async wrapUpstreamFailure(
    bareGit: SimpleGit,
    absoluteWorktreePath: string,
    branchName: string,
    createdNewBranch: boolean,
    error: unknown,
  ): Promise<UpstreamSetupError> {
    const { worktreeRemoved } = await this.rollbackPartialWorktree(
      bareGit,
      absoluteWorktreePath,
      branchName,
      createdNewBranch,
      "upstream setup error",
    );
    return new UpstreamSetupError(branchName, error, worktreeRemoved);
  }

  // The one rollback every post-registration failure goes through (sparse
  // setup, upstream setup, metadata): unregister and delete the worktree git
  // just created, and the branch too when this add created it. Never throws —
  // the caller's own error is what must propagate — and reports whether the
  // worktree really went, which UpstreamSetupError carries to the caller.
  private async rollbackPartialWorktree(
    bareGit: SimpleGit,
    absoluteWorktreePath: string,
    branchName: string,
    createdNewBranch: boolean,
    failureContext?: string,
  ): Promise<{ worktreeRemoved: boolean }> {
    let worktreeRemoved = true;
    try {
      await bareGit.raw(["worktree", "remove", "--force", absoluteWorktreePath]);
      this.ctx.forgetCachedClients(absoluteWorktreePath);
    } catch (rollbackError) {
      worktreeRemoved = false;
      const ctx = failureContext ? ` after ${failureContext}` : "";
      this.logger.warn(
        `  - Rollback failed for '${branchName}' at '${absoluteWorktreePath}'${ctx}: ${getErrorMessage(rollbackError)}`,
      );
    }
    if (createdNewBranch) {
      try {
        await bareGit.raw(["branch", "-D", "--", branchName]);
      } catch (branchRollbackError) {
        this.logger.warn(
          `  - Rollback (branch delete) failed for '${branchName}': ${getErrorMessage(branchRollbackError)}`,
        );
      }
    }
    return { worktreeRemoved };
  }

  // Resolves to the worktree's HEAD, which the metadata records as lastSyncCommit.
  private async createWorktreeMetadata(bareGit: SimpleGit, worktreePath: string, branchName: string): Promise<string> {
    try {
      const worktreeGit = this.ctx.localGit(worktreePath, this.ctx.isLfsSkipEnabled());
      const currentCommit = (await worktreeGit.revparse(["HEAD"])).trim();
      // refs/heads/<default>, not the bare name: a tag sharing the default
      // branch's name resolves first and would record the tag's commit as the
      // worktree's parent.
      const parentCommit = await bareGit.revparse([`${GIT_CONSTANTS.REFS.HEADS}${this.ctx.defaultBranch()}`]);

      const written = await this.deps.metadata.createInitialMetadataFromPath(
        this.ctx.bareRepoPath,
        worktreePath,
        currentCommit,
        `origin/${branchName}`,
        this.ctx.defaultBranch(),
        parentCommit.trim(),
      );
      // Metadata is keyed by directory name. A record under this name that
      // belongs to another branch was left alone, and a worktree cannot be
      // auto-managed on another branch's record, so the refusal fails the add.
      if (written === false) {
        throw new Error(`a metadata record for another branch already exists under '${path.basename(worktreePath)}'`);
      }
      return currentCommit;
    } catch (metadataError) {
      this.logger.error(`  - ❌ Failed to create metadata for '${branchName}': ${String(metadataError)}`);
      throw new Error(`Metadata creation failed for ${branchName}. This worktree cannot be auto-managed.`);
    }
  }

  // Records metadata for a worktree addWorktree just created. A worktree sync
  // has no metadata for cannot be auto-managed, so on failure it is removed
  // again (with the branch, when this add created it) before the typed error
  // propagates.
  private async createMetadataOrRollback(
    bareGit: SimpleGit,
    absoluteWorktreePath: string,
    branchName: string,
    createdNewBranch: boolean,
  ): Promise<AddWorktreeResult> {
    try {
      const head = await this.createWorktreeMetadata(bareGit, absoluteWorktreePath, branchName);
      return { status: "created", head };
    } catch (metadataError) {
      this.logger.warn(`  - Metadata creation failed for '${branchName}', removing worktree to prevent orphan`);
      await this.rollbackPartialWorktree(bareGit, absoluteWorktreePath, branchName, createdNewBranch);
      throw new WorktreeMetadataError(branchName, metadataError);
    }
  }

  // Registers the worktree and writes its .git link without populating files —
  // restore moves the preserved payload in instead of checking anything out,
  // keeping that link. The directory it leaves holds exactly one entry, the
  // `.git` file, which is what makes replacing the directory wholesale safe.
  async addWorktreeNoCheckout(branchName: string, worktreePath: string): Promise<void> {
    const bareGit = this.ctx.localGit(this.ctx.bareRepoPath);
    const absoluteWorktreePath = path.resolve(worktreePath);
    await fs.mkdir(path.dirname(absoluteWorktreePath), { recursive: true });
    await bareGit.raw(["worktree", "add", "--no-checkout", "--", absoluteWorktreePath, branchName]);
  }

  // A stale directory is content sync did not create and cannot inspect: a
  // .git inside may be a live checkout git failed to report, and anything else
  // may be files someone left there by hand. Without trash it is quarantined
  // under .removed/, never deleted — only an empty directory is removed.
  private async clearStaleWorktreeDirectory(absoluteWorktreePath: string): Promise<void> {
    // However this ends — the directory is already gone, or it is about to be
    // trashed, quarantined or deleted — no client cached for the path outlives
    // it. Dropping them up front covers every exit below; the refusal paths
    // leave the directory in place and cost nothing but a rebuilt client.
    this.ctx.forgetCachedClients(absoluteWorktreePath);
    // Nothing at the path means nothing to clear. Falling through would hand a
    // missing directory to the trasher, which fails with ENOENT and turns a
    // recoverable stale registration into a permanent creation failure.
    const dirProbe = await probePathExists(absoluteWorktreePath);
    if (dirProbe === "missing") {
      return;
    }
    if (dirProbe === "unknown") {
      throw new GitOperationError(
        "clear-stale-directory",
        `Cannot verify whether '${absoluteWorktreePath}' still exists; refusing to clear it`,
      );
    }

    const gitProbe = await probePathExists(path.join(absoluteWorktreePath, PATH_CONSTANTS.GIT_DIR));

    if (gitProbe === "unknown") {
      throw new GitOperationError(
        "clear-stale-directory",
        `Cannot verify whether '${absoluteWorktreePath}' is a live checkout; refusing to clear it`,
      );
    }

    if (this.staleDirectoryTrasher) {
      try {
        const trashPath = await this.staleDirectoryTrasher(absoluteWorktreePath);
        this.logger.info(`  - Moved stale directory at '${absoluteWorktreePath}' to trash ('${trashPath}')`);
        return;
      } catch (error) {
        // Cannot preserve it -> refuse to clear it (the caller's worktree
        // creation fails rather than silently deleting unknown content).
        throw new GitOperationError(
          "clear-stale-directory",
          `Cannot move stale directory '${absoluteWorktreePath}' to trash: ${getErrorMessage(error)}`,
          error instanceof Error ? error : undefined,
        );
      }
    }

    // An empty directory holds nothing to lose. rmdir (never a recursive rm)
    // refuses if something landed in it since the listing, and any refusal
    // falls through to the quarantine below.
    if (gitProbe === "missing" && (await WorktreeCreationService.isEmptyDirectory(absoluteWorktreePath))) {
      try {
        await fs.rmdir(absoluteWorktreePath);
        this.logger.info(`  - Removed empty stale directory at '${absoluteWorktreePath}'`);
        return;
      } catch {
        // Not empty any more, or not removable: preserve it instead.
      }
    }

    let quarantinePath: string;
    try {
      quarantinePath = await quarantineDirectory(absoluteWorktreePath);
    } catch (error) {
      // Same contract as the trash path: cannot preserve it -> refuse to clear
      // it, and the worktree creation fails instead of deleting anything.
      throw new GitOperationError(
        "clear-stale-directory",
        `Cannot quarantine stale directory '${absoluteWorktreePath}': ${getErrorMessage(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
    const what = gitProbe === "exists" ? "contains a .git" : "is not a registered worktree";
    this.logger.warn(
      `  - ⚠️ Directory at '${absoluteWorktreePath}' ${what}; quarantined to '${quarantinePath}' instead of deleting.`,
    );
  }

  // True only for a directory positively read as empty; an unreadable one is
  // treated as holding content.
  private static async isEmptyDirectory(dirPath: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(dirPath);
      return Array.isArray(entries) && entries.length === 0;
    } catch {
      return false;
    }
  }
}
