import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";

import { DEFAULT_CONFIG, ENV_CONSTANTS, GIT_CONSTANTS } from "../constants";
import { ConfigError } from "../errors";
import { getErrorMessage, isLfsError } from "../utils/lfs-error";

import { BranchCreatedActionsService } from "./branch-created-actions.service";
import { HookExecutionService } from "./hook-execution.service";

import type { GitService } from "./git.service";
import type { Logger } from "./logger.service";
import type { Config, RepositoryConfig } from "../types";
import type { SimpleGit, SimpleGitOptions, SimpleGitProgressEvent } from "simple-git";

export class CloneSyncService {
  private initialized = false;
  private resolvedBranch: string | null = null;
  private branchCreatedActions: BranchCreatedActionsService;
  private hookExecutionService: HookExecutionService;

  constructor(
    private config: Config,
    private gitService: GitService,
    private logger: Logger,
    options: {
      branchCreatedActions?: BranchCreatedActionsService;
      hookExecutionService?: HookExecutionService;
    } = {},
  ) {
    this.branchCreatedActions = options.branchCreatedActions ?? new BranchCreatedActionsService();
    this.hookExecutionService = options.hookExecutionService ?? new HookExecutionService();
  }

  updateLogger(logger: Logger): void {
    this.logger = logger;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  cleanup(): void {
    this.hookExecutionService.cleanup();
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

  private makeProgressHandler(): (event: SimpleGitProgressEvent) => void {
    return (event: SimpleGitProgressEvent): void => {
      if (event.method !== "clone" && event.method !== "fetch" && event.method !== "pull") return;
      if (event.progress % GIT_CONSTANTS.PROGRESS_BUCKET_PERCENT !== 0 && event.progress !== 100) return;
      const total = event.total > 0 ? `${event.processed}/${event.total}` : `${event.processed}`;
      this.logger.info(`  ↳ ${event.method} ${event.stage}: ${event.progress}% (${total})`);
    };
  }

  private buildGitOptions(blockMs: number): Partial<SimpleGitOptions> {
    const options: Partial<SimpleGitOptions> = { progress: this.makeProgressHandler() };
    if (blockMs > 0) options.timeout = { block: blockMs };
    return options;
  }

  private clientFor(dir: string, blockMs: number): SimpleGit {
    const base = simpleGit(dir, this.buildGitOptions(blockMs));
    return this.isLfsSkipEnabled() ? base.env({ [ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE]: "1" }) : base;
  }

  async resolveBranch(): Promise<string> {
    if (this.resolvedBranch) return this.resolvedBranch;
    if (this.config.branch) {
      this.resolvedBranch = this.config.branch;
      return this.resolvedBranch;
    }
    this.logger.info(`No branch configured for '${this.repoName}', detecting remote default branch...`);
    this.resolvedBranch = await this.gitService.getRemoteDefaultBranch(this.config.repoUrl);
    this.logger.info(`  ↳ resolved default branch: ${this.resolvedBranch}`);
    return this.resolvedBranch;
  }

  async initialize(): Promise<void> {
    const branch = await this.resolveBranch();
    const worktreeDir = this.config.worktreeDir;
    const gitDir = path.join(worktreeDir, ".git");

    let preExisted = true;
    let preExistedEmpty = false;
    try {
      const entries = await fs.readdir(worktreeDir);
      preExistedEmpty = entries.length === 0;
    } catch {
      preExisted = false;
    }

    await fs.mkdir(path.dirname(worktreeDir), { recursive: true });

    let needsClone = true;
    try {
      const stat = await fs.stat(gitDir);
      if (stat.isDirectory() || stat.isFile()) {
        needsClone = false;
      }
    } catch {
      // .git missing → needs clone
    }

    if (!needsClone) {
      await this.validateExistingClone(branch);
      this.initialized = true;
      return;
    }

    if (preExisted && !preExistedEmpty) {
      throw new ConfigError(
        `Cannot clone into '${worktreeDir}': directory exists and is not empty. ` +
          `Remove existing contents or point worktreeDir at an empty path.`,
        "CLONE_DESTINATION_NOT_EMPTY",
      );
    }

    if (!preExisted) {
      await fs.mkdir(worktreeDir, { recursive: true });
    }

    this.logger.info(`Cloning '${this.config.repoUrl}' (${branch}) into '${worktreeDir}'...`);

    const cloneCreatedDir = !preExisted;
    const cloneGit = simpleGit(this.buildGitOptions(this.getCloneTimeoutMs()));
    const cloneClient = this.isLfsSkipEnabled() ? cloneGit.env({ [ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE]: "1" }) : cloneGit;

    try {
      await cloneClient.clone(this.config.repoUrl, worktreeDir, ["--branch", branch, "--single-branch", "--progress"]);
    } catch (error) {
      await this.maybeCleanupPartialClone(worktreeDir, cloneCreatedDir);
      throw error;
    }

    this.logger.info(`✅ Clone successful.`);

    if (this.config.sparseCheckout) {
      this.logger.info(`Applying sparse-checkout patterns to '${worktreeDir}'...`);
      const sparseService = this.gitService.getSparseCheckoutService();
      await sparseService.applyToWorktree(worktreeDir, this.config.sparseCheckout);
      const worktreeGit = this.clientFor(worktreeDir, this.getFetchTimeoutMs());
      await worktreeGit.raw(["checkout", "HEAD"]);
    }

    await this.gitService.verifyLfs(worktreeDir, branch);

    await this.runInitialBranchActions(worktreeDir, branch);

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

    const looksIncomplete = entries.every((e) => e === ".git" || e === ".gitignore" || e.startsWith("."));
    const hasGitDir = entries.includes(".git");
    let headExists = false;
    if (hasGitDir) {
      try {
        await fs.access(path.join(worktreeDir, ".git", "HEAD"));
        headExists = true;
      } catch {
        headExists = false;
      }
    }

    if (looksIncomplete && (!hasGitDir || !headExists)) {
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
    return path.join(worktreeDir, ".git", ".sync-worktrees-clone-init");
  }

  private async runInitialBranchActions(worktreeDir: string, branch: string): Promise<void> {
    const marker = this.getInitMarkerPath(worktreeDir);
    try {
      await fs.access(marker);
      return;
    } catch {
      // marker absent → run actions
    }

    const sourceDir = this.config.__configFileDir ?? worktreeDir;

    await this.branchCreatedActions.run({
      config: this.config,
      repoName: this.repoName,
      branchName: branch,
      worktreePath: worktreeDir,
      baseBranch: branch,
      sourceDir,
      logger: this.logger,
      hookExecutionService: this.hookExecutionService,
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
      return;
    }

    if (currentBranch !== branch) {
      this.logger.warn(
        `Clone at '${worktreeDir}' is on '${currentBranch}', expected '${branch}'. Skipping fetch+merge.`,
      );
      return;
    }

    try {
      await git.fetch(["origin", branch, "--prune", "--progress"]);
    } catch (fetchError) {
      const message = getErrorMessage(fetchError);
      if (isLfsError(message)) {
        this.logger.info(`⚠️  LFS error during fetch for '${this.repoName}'; retrying with LFS disabled.`);
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
        return;
      } else {
        throw fetchError;
      }
    }

    if (this.config.sparseCheckout) {
      const sparseService = this.gitService.getSparseCheckoutService();
      try {
        await sparseService.applyToWorktree(worktreeDir, this.config.sparseCheckout);
      } catch (error) {
        this.logger.warn(`Failed to reapply sparse-checkout for '${this.repoName}': ${getErrorMessage(error)}`);
      }
    }

    const isClean = await this.gitService.checkWorktreeStatus(worktreeDir);
    if (!isClean) {
      this.logger.info(`⏭️  Skipping ff-merge for '${this.repoName}' — working tree has local changes.`);
      return;
    }

    const canFastForward = await this.gitService.canFastForward(worktreeDir, branch);
    if (!canFastForward) {
      const isAhead = await this.gitService.isLocalAheadOfRemote(worktreeDir, branch);
      if (isAhead) {
        this.logger.info(`⏭️  '${this.repoName}' has unpushed commits ahead of origin/${branch}. Skipping merge.`);
      } else {
        this.logger.info(`⏭️  '${this.repoName}' has diverged from origin/${branch}. Skipping merge (no auto-reset).`);
      }
      return;
    }

    const isBehind = await this.gitService.isWorktreeBehind(worktreeDir);
    if (!isBehind) {
      this.logger.info(`'${this.repoName}' already up to date with origin/${branch}.`);
      return;
    }

    this.logger.info(`Fast-forwarding '${this.repoName}' to origin/${branch}...`);
    await git.merge([`origin/${branch}`, "--ff-only"]);
    this.logger.info(`✅ Updated '${this.repoName}' to origin/${branch}.`);
  }
}
