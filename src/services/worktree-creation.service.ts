import * as fs from "fs/promises";
import * as path from "path";

import { GIT_CONSTANTS, PATH_CONSTANTS } from "../constants";
import { GitOperationError, UpstreamSetupError, WorktreeError, WorktreeMetadataError } from "../errors";
import { getErrorMessage } from "../utils/errors";
import { probePathExists } from "../utils/file-exists";
import { findByWorktreePath } from "../utils/path-compare";
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

const ALREADY_REGISTERED_WORKTREE = "already registered worktree";

export class WorktreeCreationService {
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

  async addWorktree(branchName: string, worktreePath: string): Promise<AddWorktreeResult> {
    const bareGit = this.ctx.localGit(this.ctx.bareRepoPath, this.ctx.isLfsSkipEnabled());
    const absoluteWorktreePath = path.resolve(worktreePath);
    await fs.mkdir(path.dirname(absoluteWorktreePath), { recursive: true });

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

      if (error instanceof UpstreamSetupError || error instanceof WorktreeMetadataError) {
        throw error;
      }

      if (errorMessage.includes(ALREADY_REGISTERED_WORKTREE)) {
        return this.recoverFromStaleRegistration(bareGit, branchName, absoluteWorktreePath);
      }

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

  private async claimWorktreePath(
    bareGit: SimpleGit,
    absoluteWorktreePath: string,
    branchName: string,
    cleanupContext: string,
  ): Promise<AddWorktreeResult | null> {
    try {
      await fs.access(absoluteWorktreePath);
      const worktrees = await this.deps.registry.getWorktreesFromBare(bareGit, true);
      const registered = await findByWorktreePath(worktrees, absoluteWorktreePath);

      if (registered) {
        this.logger.info(`  - Worktree for '${branchName}' already exists at '${absoluteWorktreePath}'`);
        return { status: "already_registered", detached: registered.detached === true };
      }
      this.logger.info(`  - Cleaning up orphaned directory at '${absoluteWorktreePath}'${cleanupContext}`);
      await this.clearStaleWorktreeDirectory(absoluteWorktreePath);
    } catch (error) {
      if (error instanceof GitOperationError || error instanceof WorktreeError) {
        throw error;
      }
    }
    return null;
  }

  private async findConcurrentRegistration(
    bareGit: SimpleGit,
    absoluteWorktreePath: string,
  ): Promise<RegisteredWorktree | undefined> {
    const worktrees = await this.deps.registry.getWorktreesFromBare(bareGit, true);
    const existingWorktree = await findByWorktreePath(worktrees, absoluteWorktreePath);
    return existingWorktree && !existingWorktree.isPrunable ? existingWorktree : undefined;
  }

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

  private async addWithoutTracking(
    bareGit: SimpleGit,
    branchName: string,
    absoluteWorktreePath: string,
  ): Promise<AddWorktreeResult> {
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
      const tracking = await this.deps.branchRefs.trackRemoteBranchIfExists(branchName, absoluteWorktreePath);
      this.logger.info(`  - Created worktree for '${branchName}'${tracking ? "" : " (without tracking)"}`);

      await this.deps.lfs.verifyLfsFilesDownloaded(absoluteWorktreePath, branchName);

      return await this.createMetadataOrRollback(bareGit, absoluteWorktreePath, branchName, false);
    } catch (fallbackError) {
      if (getErrorMessage(fallbackError).includes(ALREADY_REGISTERED_WORKTREE)) {
        const existingWorktree = await this.findConcurrentRegistration(bareGit, absoluteWorktreePath);
        if (existingWorktree) {
          this.logger.info(`  - Worktree for '${branchName}' was created by concurrent operation during fallback`);
          return { status: "already_registered", detached: existingWorktree.detached === true };
        }
      }

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
      const localOnlyCommits = await this.countLocalOnlyCommits(bareGit, branchName);

      await bareGit.raw(["worktree", "add", ...noCheckoutFlag, absoluteWorktreePath, branchName]);

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

  private async deleteBranchLeftByFailedAdd(bareGit: SimpleGit, branchName: string): Promise<void> {
    try {
      if (!(await this.deps.branchRefs.refExists(bareGit, `${GIT_CONSTANTS.REFS.HEADS}${branchName}`))) return;
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

  private async createWorktreeMetadata(worktreePath: string, branchName: string): Promise<string> {
    try {
      const worktreeGit = this.ctx.localGit(worktreePath, this.ctx.isLfsSkipEnabled());
      const currentCommit = (await worktreeGit.revparse(["HEAD"])).trim();

      const written = await this.deps.metadata.createInitialMetadataFromPath(
        this.ctx.bareRepoPath,
        worktreePath,
        currentCommit,
        `origin/${branchName}`,
      );
      if (written === false) {
        throw new Error(`a metadata record for another branch already exists under '${path.basename(worktreePath)}'`);
      }
      return currentCommit;
    } catch (metadataError) {
      this.logger.error(`  - ❌ Failed to create metadata for '${branchName}': ${String(metadataError)}`);
      throw new Error(`Metadata creation failed for ${branchName}. This worktree cannot be auto-managed.`);
    }
  }

  private async createMetadataOrRollback(
    bareGit: SimpleGit,
    absoluteWorktreePath: string,
    branchName: string,
    createdNewBranch: boolean,
  ): Promise<AddWorktreeResult> {
    try {
      const head = await this.createWorktreeMetadata(absoluteWorktreePath, branchName);
      return { status: "created", head };
    } catch (metadataError) {
      this.logger.warn(`  - Metadata creation failed for '${branchName}', removing worktree to prevent orphan`);
      await this.rollbackPartialWorktree(bareGit, absoluteWorktreePath, branchName, createdNewBranch);
      throw new WorktreeMetadataError(branchName, metadataError);
    }
  }

  async addWorktreeNoCheckout(branchName: string, worktreePath: string): Promise<void> {
    const bareGit = this.ctx.localGit(this.ctx.bareRepoPath);
    const absoluteWorktreePath = path.resolve(worktreePath);
    await fs.mkdir(path.dirname(absoluteWorktreePath), { recursive: true });
    await bareGit.raw(["worktree", "add", "--no-checkout", "--", absoluteWorktreePath, branchName]);
  }

  private async clearStaleWorktreeDirectory(absoluteWorktreePath: string): Promise<void> {
    this.ctx.forgetCachedClients(absoluteWorktreePath);
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
        throw new GitOperationError(
          "clear-stale-directory",
          `Cannot move stale directory '${absoluteWorktreePath}' to trash: ${getErrorMessage(error)}`,
          error instanceof Error ? error : undefined,
        );
      }
    }

    if (gitProbe === "missing" && (await WorktreeCreationService.isEmptyDirectory(absoluteWorktreePath))) {
      try {
        await fs.rmdir(absoluteWorktreePath);
        this.logger.info(`  - Removed empty stale directory at '${absoluteWorktreePath}'`);
        return;
      } catch {}
    }

    let quarantinePath: string;
    try {
      quarantinePath = await quarantineDirectory(absoluteWorktreePath);
    } catch (error) {
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

  private static async isEmptyDirectory(dirPath: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(dirPath);
      return Array.isArray(entries) && entries.length === 0;
    } catch {
      return false;
    }
  }
}
