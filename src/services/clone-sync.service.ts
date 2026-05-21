import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";

import { DEFAULT_CONFIG, ENV_CONSTANTS, PATH_CONSTANTS } from "../constants";
import { ConfigError } from "../errors";
import { fileExists } from "../utils/file-exists";
import { makeGitProgressHandler } from "../utils/git-progress";
import { getErrorMessage, isLfsError } from "../utils/lfs-error";

import { BranchCreatedActionsService } from "./branch-created-actions.service";

import type { GitService } from "./git.service";
import type { Logger } from "./logger.service";
import type { Config, RepositoryConfig } from "../types";
import type { GitProgressEmitter, GitProgressEvent } from "../utils/git-progress";
import type { SimpleGit, SimpleGitOptions } from "simple-git";

export class CloneSyncService {
  private initialized = false;
  private resolvedBranch: string | null = null;
  private branchCreatedActions: BranchCreatedActionsService;
  private progressEmitter?: GitProgressEmitter;

  constructor(
    private config: Config,
    private gitService: GitService,
    private logger: Logger,
    options: {
      branchCreatedActions?: BranchCreatedActionsService;
      progressEmitter?: GitProgressEmitter;
    } = {},
  ) {
    this.branchCreatedActions = options.branchCreatedActions ?? new BranchCreatedActionsService();
    this.progressEmitter = options.progressEmitter;
  }

  updateLogger(logger: Logger): void {
    this.logger = logger;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  private get repoName(): string {
    return (this.config as RepositoryConfig).name ?? this.config.repoUrl;
  }

  private getCloneTimeoutMs(): number {
    if (process.env.NODE_ENV === ENV_CONSTANTS.NODE_ENV_TEST) return 0;
    return this.config.cloneTimeoutMs ?? DEFAULT_CONFIG.CLONE_TIMEOUT_MS;
  }

  private getFetchTimeoutMs(): number {
    if (process.env.NODE_ENV === ENV_CONSTANTS.NODE_ENV_TEST) return 0;
    return this.config.fetchTimeoutMs ?? DEFAULT_CONFIG.FETCH_TIMEOUT_MS;
  }

  private isLfsSkipEnabled(): boolean {
    return this.config.skipLfs === true;
  }

  private buildGitOptions(blockMs: number): Partial<SimpleGitOptions> {
    const options: Partial<SimpleGitOptions> = {
      progress: makeGitProgressHandler(this.logger, (event) => this.emitProgress(event)),
    };
    if (blockMs > 0) options.timeout = { block: blockMs };
    return options;
  }

  private emitProgress(event: GitProgressEvent): void {
    try {
      this.progressEmitter?.(event);
    } catch {
      // progress listeners must not break sync flow
    }
  }

  private clientFor(dir: string, blockMs: number): SimpleGit {
    const base = simpleGit(dir, this.buildGitOptions(blockMs));
    return this.isLfsSkipEnabled() ? base.env({ [ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE]: "1" }) : base;
  }

  private buildCloneArgs(branch: string): string[] {
    const args = ["--branch", branch, "--single-branch", "--progress"];
    if (this.config.depth !== undefined) {
      args.push("--depth", String(this.config.depth));
    }
    return args;
  }

  private async unshallowIfDepthRemoved(git: SimpleGit): Promise<void> {
    if (this.config.depth !== undefined) return;

    const output = await git.raw(["rev-parse", "--is-shallow-repository"]);
    if (output.trim() !== "true") return;

    this.logger.info(
      `[deepen] Existing shallow clone for '${this.repoName}' has no configured depth; fetching full history...`,
    );
    await git.fetch(["--unshallow"]);
  }

  async resolveBranch(): Promise<string> {
    if (this.resolvedBranch) return this.resolvedBranch;
    if (this.config.branch) {
      this.resolvedBranch = this.config.branch;
      this.emitProgress({ phase: "branch", message: `Using configured branch '${this.resolvedBranch}'` });
      return this.resolvedBranch;
    }
    this.logger.info(`No branch configured for '${this.repoName}', detecting remote default branch...`);
    this.emitProgress({ phase: "branch", message: `Resolving remote default branch for '${this.repoName}'` });
    this.resolvedBranch = await this.gitService.getRemoteDefaultBranch(this.config.repoUrl);
    this.logger.info(`  ↳ resolved default branch: ${this.resolvedBranch}`);
    this.emitProgress({ phase: "branch", message: `Resolved default branch '${this.resolvedBranch}'` });
    return this.resolvedBranch;
  }

  async initialize(): Promise<void> {
    const branch = await this.resolveBranch();
    const worktreeDir = this.config.worktreeDir;

    let entries: string[] | null = null;
    try {
      entries = await fs.readdir(worktreeDir);
    } catch {
      entries = null;
    }

    if (entries?.includes(PATH_CONSTANTS.GIT_DIR)) {
      this.emitProgress({ phase: "clone", message: `Validating existing clone for '${this.repoName}'` });
      await this.validateExistingClone(branch);
      this.initialized = true;
      this.emitProgress({ phase: "clone", message: `Existing clone validated for '${this.repoName}'` });
      return;
    }

    if (entries && entries.length > 0) {
      throw new ConfigError(
        `Cannot clone into '${worktreeDir}': directory exists and is not empty. ` +
          `Remove existing contents or point worktreeDir at an empty path.`,
        "CLONE_DESTINATION_NOT_EMPTY",
      );
    }

    const cloneCreatedDir = entries === null;
    await fs.mkdir(worktreeDir, { recursive: true });

    this.logger.info(`Cloning '${this.config.repoUrl}' (${branch}) into '${worktreeDir}'...`);
    this.emitProgress({ phase: "clone", message: `Cloning '${this.repoName}' (${branch})` });

    const cloneGit = simpleGit(this.buildGitOptions(this.getCloneTimeoutMs()));
    const cloneClient = this.isLfsSkipEnabled() ? cloneGit.env({ [ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE]: "1" }) : cloneGit;

    try {
      await cloneClient.clone(this.config.repoUrl, worktreeDir, this.buildCloneArgs(branch));
    } catch (error) {
      await this.maybeCleanupPartialClone(worktreeDir, cloneCreatedDir);
      throw error;
    }

    this.logger.info(`✅ Clone successful.`);
    this.emitProgress({ phase: "clone", message: `Clone successful for '${this.repoName}'` });

    if (this.config.sparseCheckout) {
      this.logger.info(`Applying sparse-checkout patterns to '${worktreeDir}'...`);
      this.emitProgress({ phase: "sparse_checkout", message: `Applying sparse-checkout for '${this.repoName}'` });
      const sparseService = this.gitService.getSparseCheckoutService();
      await sparseService.applyToWorktree(worktreeDir, this.config.sparseCheckout);
      const worktreeGit = this.clientFor(worktreeDir, this.getFetchTimeoutMs());
      await worktreeGit.raw(["checkout", "HEAD"]);
      this.emitProgress({ phase: "sparse_checkout", message: `Sparse-checkout applied for '${this.repoName}'` });
    }

    this.emitProgress({ phase: "lfs", message: `Verifying LFS for '${this.repoName}'` });
    await this.gitService.verifyLfs(worktreeDir, branch);
    this.emitProgress({ phase: "lfs", message: `LFS verified for '${this.repoName}'` });

    await this.runInitialFileCopy(worktreeDir, branch);

    this.initialized = true;
  }

  private async validateExistingClone(expectedBranch: string): Promise<void> {
    const worktreeDir = this.config.worktreeDir;
    const git = this.clientFor(worktreeDir, this.getFetchTimeoutMs());

    try {
      const originUrl = (await git.raw(["remote", "get-url", "origin"])).trim();
      if (originUrl && originUrl !== this.config.repoUrl) {
        this.logger.warn(
          `Existing clone at '${worktreeDir}' has origin '${originUrl}', expected '${this.config.repoUrl}'.`,
        );
      }
    } catch {
      this.logger.warn(`Could not read 'origin' remote URL from existing clone at '${worktreeDir}'.`);
    }

    let currentBranch: string;
    try {
      currentBranch = (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    } catch (error) {
      throw new ConfigError(
        `Existing directory at '${worktreeDir}' has a .git folder but reading HEAD failed: ${getErrorMessage(error)}`,
        "CLONE_VALIDATION_FAILED",
      );
    }

    if (currentBranch !== expectedBranch) {
      throw new ConfigError(
        `Existing clone at '${worktreeDir}' is on branch '${currentBranch}', expected '${expectedBranch}'. ` +
          `Switch the working tree to '${expectedBranch}' or update the config.`,
        "CLONE_BRANCH_MISMATCH",
      );
    }
  }

  private async maybeCleanupPartialClone(worktreeDir: string, cloneCreatedDir: boolean): Promise<void> {
    if (!cloneCreatedDir) {
      this.logger.warn(
        `Clone failed; leaving '${worktreeDir}' for manual inspection (directory existed before clone attempt).`,
      );
      return;
    }

    let entries: string[];
    try {
      entries = await fs.readdir(worktreeDir);
    } catch {
      return;
    }

    const looksIncomplete = entries.every((e) => e.startsWith("."));
    const hasUsableGit =
      entries.includes(PATH_CONSTANTS.GIT_DIR) &&
      (await fileExists(path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR, "HEAD")));

    if (looksIncomplete && !hasUsableGit) {
      try {
        await fs.rm(worktreeDir, { recursive: true, force: true });
        this.logger.info(`Cleaned up incomplete clone at '${worktreeDir}'.`);
      } catch (rmError) {
        this.logger.warn(`Failed to clean up incomplete clone at '${worktreeDir}': ${getErrorMessage(rmError)}`);
      }
    } else {
      this.logger.warn(
        `Clone failed; leaving '${worktreeDir}' for manual inspection (post-failure contents do not look like an empty incomplete clone).`,
      );
    }
  }

  private getInitMarkerPath(worktreeDir: string): string {
    return path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR, PATH_CONSTANTS.CLONE_INIT_MARKER);
  }

  private async runInitialFileCopy(worktreeDir: string, branch: string): Promise<void> {
    const marker = this.getInitMarkerPath(worktreeDir);
    if (await fileExists(marker)) {
      return;
    }

    const sourceDir = this.config.__configFileDir ?? worktreeDir;

    await this.branchCreatedActions.copyFiles({
      config: this.config,
      branchName: branch,
      worktreePath: worktreeDir,
      sourceDir,
      logger: this.logger,
    });

    try {
      await fs.writeFile(marker, new Date().toISOString());
    } catch (error) {
      this.logger.warn(`Could not write clone-init marker: ${getErrorMessage(error)}`);
    }
  }

  async runSyncAttempt(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
      return;
    }

    const branch = await this.resolveBranch();
    const worktreeDir = this.config.worktreeDir;
    const git = this.clientFor(worktreeDir, this.getFetchTimeoutMs());

    let currentBranch: string;
    try {
      currentBranch = (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    } catch (error) {
      this.logger.warn(`Could not read current branch from '${worktreeDir}': ${getErrorMessage(error)}`);
      this.emitProgress({
        phase: "skip",
        message: `Skipping '${this.repoName}': could not read current branch`,
      });
      return;
    }

    if (currentBranch !== branch) {
      this.logger.warn(
        `Clone at '${worktreeDir}' is on '${currentBranch}', expected '${branch}'. Skipping fetch+merge.`,
      );
      this.emitProgress({
        phase: "skip",
        message: `Skipping '${this.repoName}': current branch '${currentBranch}' is not '${branch}'`,
      });
      return;
    }

    await this.unshallowIfDepthRemoved(git);

    this.emitProgress({ phase: "fetch", message: `Fetching origin/${branch} for '${this.repoName}'` });
    try {
      await git.fetch(["origin", branch, "--prune", "--progress"]);
    } catch (fetchError) {
      const message = getErrorMessage(fetchError);
      if (isLfsError(message)) {
        this.logger.info(`⚠️  LFS error during fetch for '${this.repoName}'; retrying with LFS disabled.`);
        this.emitProgress({
          phase: "fetch",
          message: `Retrying fetch for '${this.repoName}' with LFS disabled`,
        });
        const lfsSkipGit = simpleGit(worktreeDir, this.buildGitOptions(this.getFetchTimeoutMs())).env({
          [ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE]: "1",
        });
        await lfsSkipGit.fetch(["origin", branch, "--prune", "--progress"]);
      } else if (
        message.includes("couldn't find remote ref") ||
        message.includes("Couldn't find remote ref") ||
        message.includes("not our ref")
      ) {
        this.logger.warn(`Tracked branch '${branch}' is missing on remote for '${this.repoName}'. Skipping sync.`);
        this.emitProgress({
          phase: "skip",
          message: `Skipping '${this.repoName}': origin/${branch} is missing`,
        });
        return;
      } else {
        throw fetchError;
      }
    }
    this.emitProgress({ phase: "fetch", message: `Fetched origin/${branch} for '${this.repoName}'` });

    if (this.config.sparseCheckout) {
      const sparseService = this.gitService.getSparseCheckoutService();
      try {
        if (await sparseService.needsUpdate(worktreeDir, this.config.sparseCheckout)) {
          this.emitProgress({ phase: "sparse_checkout", message: `Updating sparse-checkout for '${this.repoName}'` });
          await sparseService.applyToWorktree(worktreeDir, this.config.sparseCheckout);
          this.emitProgress({ phase: "sparse_checkout", message: `Sparse-checkout updated for '${this.repoName}'` });
        }
      } catch (error) {
        this.logger.warn(`Failed to reapply sparse-checkout for '${this.repoName}': ${getErrorMessage(error)}`);
      }
    }

    const isClean = await this.gitService.checkWorktreeStatus(worktreeDir);
    if (!isClean) {
      this.logger.info(`⏭️  Skipping ff-merge for '${this.repoName}' — working tree has local changes.`);
      this.emitProgress({
        phase: "skip",
        message: `Skipping merge for '${this.repoName}': working tree has local changes`,
      });
      return;
    }

    const canFastForward = await this.gitService.canFastForward(worktreeDir, branch);
    if (!canFastForward) {
      const isAhead = await this.gitService.isLocalAheadOfRemote(worktreeDir, branch);
      if (isAhead) {
        this.logger.info(`⏭️  '${this.repoName}' has unpushed commits ahead of origin/${branch}. Skipping merge.`);
        this.emitProgress({
          phase: "skip",
          message: `Skipping merge for '${this.repoName}': unpushed commits ahead of origin/${branch}`,
        });
      } else {
        this.logger.info(`⏭️  '${this.repoName}' has diverged from origin/${branch}. Skipping merge (no auto-reset).`);
        this.emitProgress({
          phase: "skip",
          message: `Skipping merge for '${this.repoName}': diverged from origin/${branch}`,
        });
      }
      return;
    }

    const isBehind = await this.gitService.isWorktreeBehind(worktreeDir);
    if (!isBehind) {
      this.logger.info(`'${this.repoName}' already up to date with origin/${branch}.`);
      this.emitProgress({
        phase: "skip",
        message: `'${this.repoName}' already up to date with origin/${branch}`,
      });
      return;
    }

    this.logger.info(`Fast-forwarding '${this.repoName}' to origin/${branch}...`);
    this.emitProgress({ phase: "merge", message: `Fast-forwarding '${this.repoName}' to origin/${branch}` });
    await git.merge([`origin/${branch}`, "--ff-only"]);
    this.logger.info(`✅ Updated '${this.repoName}' to origin/${branch}.`);
    this.emitProgress({ phase: "merge", message: `Updated '${this.repoName}' to origin/${branch}` });
  }
}
