import * as path from "path";

import { DEFAULT_CONFIG, ENV_CONSTANTS, ERROR_MESSAGES, GIT_CONSTANTS } from "../constants";
import { ConfigError, GitOperationError, WorktreeError } from "../errors";
import { probePathExists } from "../utils/file-exists";
import { createGitClient } from "../utils/git-client";
import { GitClientCache } from "../utils/git-client-cache";
import { sshNoPromptEnv } from "../utils/git-env";
import { makeGitProgressHandler } from "../utils/git-progress";
import { getDefaultBareRepoDir } from "../utils/git-url";
import { getErrorMessage } from "../utils/errors";
import { findByWorktreePath, sameWorktreePath } from "../utils/path-compare";
import { REPOSITORY_MODES, resolveMode } from "../utils/repo-mode";
import { isUnitTestShortcutEnabled } from "../utils/unit-test-shortcut";

import { BareRepoService } from "./bare-repo.service";
import { undoRejectedFastForwardIn } from "./clone-sync/fast-forward-undo";
import { BranchRefService } from "./branch-ref.service";
import { LfsVerificationService } from "./lfs-verification.service";
import { Logger } from "./logger.service";
import { PathResolutionService } from "./path-resolution.service";
import { SparseCheckoutService } from "./sparse-checkout.service";
import { WorktreeCreationService } from "./worktree-creation.service";
import { WorktreeMetadataService } from "./worktree-metadata.service";
import { WorktreeRegistryService } from "./worktree-registry.service";
import { WorktreeStatusService } from "./worktree-status.service";

import type {
  AddWorktreeResult,
  AheadBehindCounts,
  DefaultBranchRefresh,
  GitServiceContext,
  GitServiceOptions,
  RegisteredWorktree,
  RemoteRelationship,
  UncachedGitClientOptions,
  WorktreeUpdateResult,
} from "./git-service.types";
import type { RefScanScope, WorktreeStatusResult } from "./worktree-status.service";
import type { SyncMetadata } from "../types/sync-metadata";
import type { GitProgressEmitter, GitProgressEvent } from "../utils/git-progress";
import type { SimpleGit, SimpleGitOptions } from "simple-git";

export type {
  AddWorktreeResult,
  AheadBehindCounts,
  DefaultBranchRefresh,
  GitServiceOptions,
  RegisteredWorktree,
  RemoteRelationship,
  WorktreeUpdateResult,
} from "./git-service.types";

export class GitService {
  private git: SimpleGit | null = null;
  private readonly bareRepoPathOrNull: string | null;
  private mainWorktreePath: string;
  private defaultBranch: string = GIT_CONSTANTS.DEFAULT_BRANCH;
  private initializeFetched = false;
  private metadataService: WorktreeMetadataService;
  private statusService: WorktreeStatusService;
  private probeStatusService: WorktreeStatusService | null = null;
  private sparseCheckoutService: SparseCheckoutService;
  private logger: Logger;
  private lfsSkipOverride = false;
  private gitInstances = new GitClientCache();
  private readonly branchRefs: BranchRefService;
  private readonly registry: WorktreeRegistryService;
  private readonly lfs: LfsVerificationService;
  private readonly bareRepo: BareRepoService;
  private readonly creation: WorktreeCreationService;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly pathResolution = new PathResolutionService();

  constructor(
    private config: GitServiceOptions,
    logger?: Logger,
    private progressEmitter?: GitProgressEmitter,
    options: { readOnly?: boolean } = {},
  ) {
    this.baseEnv = options.readOnly ? { [ENV_CONSTANTS.GIT_OPTIONAL_LOCKS]: "0" } : {};
    this.logger = logger ?? Logger.createDefault(undefined, config.debug);
    this.bareRepoPathOrNull =
      resolveMode(this.config) === REPOSITORY_MODES.CLONE
        ? null
        : this.config.bareRepoDir || getDefaultBareRepoDir(this.config.repoUrl);
    this.mainWorktreePath = path.join(this.config.worktreeDir, GIT_CONSTANTS.DEFAULT_BRANCH);
    this.metadataService = new WorktreeMetadataService(this.logger);
    this.statusService = new WorktreeStatusService(
      {
        skipLfs: this.config.skipLfs,
        maxConcurrentGitProcesses: this.config.parallelism?.maxStatusChecks,
        ...(options.readOnly && { extraEnv: this.baseEnv }),
      },
      this.logger,
    );
    this.sparseCheckoutService = new SparseCheckoutService(this.logger, (worktreePath) =>
      this.getCachedGit(worktreePath, this.isLfsSkipEnabled()),
    );

    const ctx = this.createContext();
    this.branchRefs = new BranchRefService(ctx);
    this.registry = new WorktreeRegistryService(ctx, this.metadataService);
    this.lfs = new LfsVerificationService(ctx);
    this.bareRepo = new BareRepoService(ctx, this.branchRefs);
    this.creation = new WorktreeCreationService(ctx, {
      registry: this.registry,
      branchRefs: this.branchRefs,
      lfs: this.lfs,
      sparseCheckout: this.sparseCheckoutService,
      metadata: this.metadataService,
    });
  }

  private get bareRepoPath(): string {
    if (this.bareRepoPathOrNull === null) {
      throw new ConfigError("A clone-mode repository has no bare repository", "WORKTREE_MODE_REQUIRED");
    }
    return this.bareRepoPathOrNull;
  }

  private createContext(): GitServiceContext {
    const readBareRepoPath = (): string => this.bareRepoPath;
    return {
      config: this.config,
      get bareRepoPath(): string {
        return readBareRepoPath();
      },
      logger: () => this.logger,
      defaultBranch: () => this.defaultBranch,
      localGit: (dirPath, useLfsSkip) => this.getCachedGit(dirPath, useLfsSkip),
      networkGit: (dirPath, useLfsSkip) => this.getCachedNetworkGit(dirPath, useLfsSkip),
      uncachedGit: (dirPath, options) => this.createUncachedGit(dirPath, options),
      fetchTimeoutMs: () => this.getFetchTimeoutMs(),
      cloneTimeoutMs: () => this.getCloneTimeoutMs(),
      isLfsSkipEnabled: () => this.isLfsSkipEnabled(),
      forgetCachedClients: (dirPath) => this.forgetCachedClients(dirPath),
    };
  }

  private createUncachedGit(dirPath: string | undefined, options: UncachedGitClientOptions): SimpleGit {
    return createGitClient(
      dirPath,
      this.buildGitEnv(options.useLfsSkip, options.extraEnv),
      this.buildSimpleGitOptions(options.blockMs),
    );
  }

  getBaseGitEnv(): NodeJS.ProcessEnv {
    return { ...this.baseEnv };
  }

  getSparseCheckoutService(): SparseCheckoutService {
    return this.sparseCheckoutService;
  }

  private getFetchTimeoutMs(): number {
    if (isUnitTestShortcutEnabled()) return 0;
    return this.config.fetchTimeoutMs ?? DEFAULT_CONFIG.FETCH_TIMEOUT_MS;
  }

  private getCloneTimeoutMs(): number {
    if (isUnitTestShortcutEnabled()) return 0;
    return this.config.cloneTimeoutMs ?? DEFAULT_CONFIG.CLONE_TIMEOUT_MS;
  }

  private getCachedClient(dirPath: string, useLfsSkip: boolean, kind: "local" | "network"): SimpleGit {
    return this.gitInstances.get(dirPath, `${useLfsSkip ? "1" : "0"}::${kind}`, () =>
      createGitClient(
        dirPath,
        this.buildGitEnv(useLfsSkip),
        this.buildSimpleGitOptions(kind === "network" ? this.getFetchTimeoutMs() : 0),
      ),
    );
  }

  private buildGitEnv(useLfsSkip: boolean, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...sshNoPromptEnv(this.config.repoUrl), ...this.baseEnv, ...extra };
    if (useLfsSkip) env[ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE] = "1";
    return env;
  }

  private forgetCachedClients(dirPath: string): void {
    this.gitInstances.forget(dirPath);
    this.statusService.forgetWorktree(dirPath);
    this.probeStatusService?.forgetWorktree(dirPath);
  }

  private getCachedGit(dirPath: string, useLfsSkip = false): SimpleGit {
    return this.getCachedClient(dirPath, useLfsSkip, "local");
  }

  private getCachedNetworkGit(dirPath: string, useLfsSkip = false): SimpleGit {
    return this.getCachedClient(dirPath, useLfsSkip, "network");
  }

  private buildSimpleGitOptions(blockMs: number): Partial<SimpleGitOptions> {
    const options: Partial<SimpleGitOptions> = {
      progress: makeGitProgressHandler(
        () => this.logger,
        (event) => this.progressEmitter?.(event),
      ),
    };
    if (blockMs > 0) options.timeout = { block: blockMs };
    return options;
  }

  updateLogger(logger: Logger): void {
    this.logger = logger;
    this.metadataService.updateLogger(logger);
    this.statusService.updateLogger(logger);
    this.probeStatusService?.updateLogger(logger);
    this.sparseCheckoutService.updateLogger(logger);
  }

  didInitializeFetch(): boolean {
    return this.initializeFetched;
  }

  async initialize(): Promise<SimpleGit> {
    await this.bareRepo.ensureBareRepository();
    const bareGit = this.getCachedGit(this.bareRepoPath);

    const remoteRefs = await bareGit.raw(["for-each-ref", "--count=1", "--format=%(refname)", "refs/remotes/origin/"]);
    this.initializeFetched = false;
    if (remoteRefs.trim() === "") {
      this.logger.info("Fetching remote branches...");
      await this.getCachedNetworkGit(this.bareRepoPath).fetch(["--all", "--progress"]);
      this.initializeFetched = true;
    }

    this.defaultBranch = await this.bareRepo.detectDefaultBranch(bareGit);
    this.mainWorktreePath = path.join(this.config.worktreeDir, this.defaultBranch);
    await this.ensureMainWorktree(bareGit);

    this.git = this.getCachedGit(this.mainWorktreePath);
    return this.git;
  }

  private async ensureMainWorktree(bareGit: SimpleGit): Promise<boolean> {
    let needsMainWorktree = true;
    try {
      const worktrees = await this.registry.getWorktreesFromBare(bareGit, true);
      const atTarget = await findByWorktreePath(worktrees, this.mainWorktreePath);
      const registered = atTarget ?? worktrees.find((w) => w.branch === this.defaultBranch);
      if (registered) {
        const registeredPath = path.resolve(registered.path);
        if ((await probePathExists(registeredPath)) === "missing") {
          this.logger.info(
            `${this.defaultBranch} worktree directory is missing at "${registeredPath}"; clearing its stale registration and recreating it.`,
          );
          try {
            await bareGit.raw(["worktree", "remove", "--force", registeredPath]);
            this.forgetCachedClients(registeredPath);
          } catch (removalError) {
            this.logger.warn(
              `Could not clear stale registration for '${registeredPath}': ${getErrorMessage(removalError)}`,
            );
            needsMainWorktree = false;
          }
        } else {
          if (!atTarget) {
            this.logger.info(
              `${this.defaultBranch} is already checked out at "${registered.path}"; using it as the ${this.defaultBranch} worktree.`,
            );
            this.mainWorktreePath = registered.path;
          }
          needsMainWorktree = false;
        }
      }
    } catch {}

    if (!needsMainWorktree) return false;

    this.logger.info(`Creating ${this.defaultBranch} worktree at "${this.mainWorktreePath}"...`);
    let created = false;
    try {
      created = (await this.addWorktree(this.defaultBranch, this.mainWorktreePath)).status === "created";
    } catch (error) {
      if (
        !getErrorMessage(error).includes(ERROR_MESSAGES.ALREADY_EXISTS) ||
        !(await this.registry.isRegisteredWorktree(bareGit, this.mainWorktreePath))
      ) {
        throw error;
      }
      this.logger.info(
        `${this.defaultBranch} worktree at '${this.mainWorktreePath}' was registered concurrently; reusing it.`,
      );
    }

    if (!(await this.registry.isRegisteredWorktree(bareGit, this.mainWorktreePath))) {
      throw new WorktreeError(
        `${this.defaultBranch} worktree at '${path.resolve(this.mainWorktreePath)}' is not registered with the bare repository at '${path.resolve(this.bareRepoPath)}' after creation`,
        "NOT_REGISTERED",
      );
    }
    return created;
  }

  async openForPlanning(): Promise<{ state: "missing" } | { state: "ready"; anchorMissing: boolean }> {
    if ((await probePathExists(path.join(this.bareRepoPath, "HEAD"))) !== "exists") return { state: "missing" };
    const bareGit = this.getCachedGit(this.bareRepoPath);
    await this.bareRepo.assertBareRepoOriginMatches(bareGit);

    await this.getCachedNetworkGit(this.bareRepoPath, this.isLfsSkipEnabled()).fetch([
      "--all",
      "--prune",
      "--no-auto-gc",
      "--progress",
    ]);

    this.defaultBranch = await this.bareRepo.detectDefaultBranch(bareGit, { readOnly: true });
    this.mainWorktreePath = path.join(this.config.worktreeDir, this.defaultBranch);
    const worktrees = await this.registry.getWorktreesFromBare(bareGit, true);
    const registered =
      (await findByWorktreePath(worktrees, this.mainWorktreePath)) ??
      worktrees.find((w) => w.branch === this.defaultBranch);
    const anchorMissing = !registered || (await probePathExists(registered.path)) !== "exists";
    if (registered && !anchorMissing) this.mainWorktreePath = registered.path;
    this.git = this.getCachedGit(anchorMissing ? this.bareRepoPath : this.mainWorktreePath);
    return { state: "ready", anchorMissing };
  }

  getGit(): SimpleGit {
    if (!this.git) {
      throw new Error("Git service not initialized. Call initialize() first.");
    }
    return this.git;
  }

  isInitialized(): boolean {
    return this.git !== null;
  }

  getDefaultBranch(): string {
    return this.defaultBranch;
  }

  getMainWorktreePath(): string {
    return this.mainWorktreePath;
  }

  async ensureAnchorWorktree(): Promise<boolean> {
    this.assertInitialized();
    const anchorPath = path.resolve(this.mainWorktreePath);
    const probe = await probePathExists(anchorPath);
    if (probe === "exists") return false;
    if (probe === "unknown") {
      throw new WorktreeError(
        `Cannot determine whether the ${this.defaultBranch} worktree at '${anchorPath}' still exists; refusing to run git there`,
        "ANCHOR_UNVERIFIABLE",
      );
    }

    this.logger.warn(`Default-branch worktree at '${anchorPath}' is missing; recreating it.`);
    const created = await this.ensureMainWorktree(this.getCachedGit(this.bareRepoPath));
    this.git = this.getCachedGit(this.mainWorktreePath);
    return created;
  }

  async refreshDefaultBranch(): Promise<DefaultBranchRefresh> {
    this.assertInitialized();
    const bareGit = this.getCachedGit(this.bareRepoPath);
    const previous = this.defaultBranch;

    const detected = await this.bareRepo.detectDefaultBranch(bareGit);
    if (!(await this.branchExists(detected)).remote) {
      throw new GitOperationError(
        "detect-default-branch",
        `origin/${detected} does not exist${detected === previous ? "" : ` (was '${previous}')`}; ` +
          "set the remote's HEAD to the new default branch and sync again",
      );
    }
    if (detected === previous) {
      return { previous, defaultBranch: previous, mainWorktreePath: this.mainWorktreePath, created: false };
    }

    this.logger.info(`Default branch changed from '${previous}' to '${detected}' on origin.`);
    const previousMainWorktreePath = this.mainWorktreePath;
    this.defaultBranch = detected;
    this.mainWorktreePath = path.join(this.config.worktreeDir, detected);
    let created: boolean;
    try {
      created = await this.ensureMainWorktree(bareGit);
    } catch (error) {
      this.defaultBranch = previous;
      this.mainWorktreePath = previousMainWorktreePath;
      throw error;
    }
    this.git = this.getCachedGit(this.mainWorktreePath);
    return { previous, defaultBranch: detected, mainWorktreePath: this.mainWorktreePath, created };
  }

  getBareRepoPath(): string {
    return this.bareRepoPath;
  }

  async getRemoteDefaultBranch(repoUrl: string): Promise<string> {
    return this.bareRepo.getRemoteDefaultBranch(repoUrl);
  }

  async verifyLfs(worktreePath: string, label: string): Promise<void> {
    await this.lfs.verifyLfsFilesDownloaded(worktreePath, label);
  }

  async fetchAll(): Promise<void> {
    this.assertInitialized();
    this.logger.debug("Fetching latest data from remote...");
    await this.fetchFromAnchor(["--all", "--prune", "--progress"]);
  }

  async fetchBranch(branchName: string): Promise<void> {
    this.assertInitialized();
    await this.fetchFromAnchor(["origin", `refs/heads/${branchName}`, "--prune", "--progress"]);
  }

  private async fetchFromAnchor(args: string[]): Promise<void> {
    try {
      const git = this.getCachedNetworkGit(this.mainWorktreePath, this.isLfsSkipEnabled());
      await git.fetch(args);
    } catch (error) {
      const anchorPath = path.resolve(this.mainWorktreePath);
      const message = getErrorMessage(error);
      const namesMissingWorkingDir =
        message.includes("spawn git ENOENT") || message.includes(GIT_CONSTANTS.MISSING_BASE_DIR_ERROR);
      if (namesMissingWorkingDir && (await probePathExists(anchorPath)) === "missing") {
        throw new GitOperationError(
          "fetch",
          `working directory '${anchorPath}' does not exist`,
          error instanceof Error ? error : undefined,
        );
      }
      throw error;
    }
  }

  private assertInitialized(): void {
    if (!this.git) {
      throw new Error("Git service not initialized. Call initialize() first.");
    }
  }

  async getRemoteBranches(): Promise<string[]> {
    return [...(await this.branchRefs.readRemoteBranchTips(this.getGit())).keys()];
  }

  async getRemoteBranchesWithActivity(): Promise<{ branch: string; lastActivity: Date }[]> {
    return this.branchRefs.getRemoteBranchesWithActivity(this.getGit());
  }

  async checkoutHead(worktreePath: string): Promise<void> {
    const git = this.getCachedGit(worktreePath, this.isLfsSkipEnabled());
    await git.raw(["checkout", "HEAD"]);
  }

  async resetWorktreeIndex(worktreePath: string): Promise<void> {
    const worktreeGit = this.getCachedGit(worktreePath);
    await worktreeGit.raw(["reset"]);
  }

  async addWorktree(branchName: string, worktreePath: string): Promise<AddWorktreeResult> {
    return this.creation.addWorktree(branchName, worktreePath);
  }

  async addWorktreeNoCheckout(branchName: string, worktreePath: string): Promise<void> {
    return this.creation.addWorktreeNoCheckout(branchName, worktreePath);
  }

  setStaleDirectoryTrasher(trasher: (dirPath: string) => Promise<string>): void {
    this.creation.setStaleDirectoryTrasher(trasher);
  }

  async removeWorktree(worktreePath: string, options?: { force?: boolean }): Promise<void> {
    return this.registry.removeWorktree(worktreePath, options);
  }

  async getWorktrees(options: { includeDetached?: boolean } = {}): Promise<RegisteredWorktree[]> {
    return this.registry.getWorktrees(options);
  }

  async getWorktreeLock(worktreePath: string): Promise<{ locked: boolean; reason?: string }> {
    return this.registry.getWorktreeLock(worktreePath);
  }

  async readWorktreeMetadataOwner(worktreeName: string): Promise<string | null> {
    if (this.bareRepoPathOrNull === null) return null;
    return this.metadataService.readMetadataOwner(this.bareRepoPathOrNull, worktreeName);
  }

  async resolveNewWorktreePath(branchName: string, listed?: RegisteredWorktree[]): Promise<string> {
    const worktreeDir = path.resolve(this.config.worktreeDir);
    const worktrees = listed ?? (await this.getWorktrees());
    for (const worktree of worktrees) {
      if (worktree.branch === branchName && (await sameWorktreePath(path.dirname(worktree.path), worktreeDir))) {
        return worktree.path;
      }
    }

    let branches: string[] = [];
    try {
      branches = await this.getRemoteBranches();
    } catch (error) {
      this.logger.debug(`Could not list remote branches for worktree naming: ${getErrorMessage(error)}`);
    }
    const naming = await this.pathResolution.createProbedNamingContext(
      { branches, branchesToName: [branchName], defaultBranch: this.defaultBranch, worktrees },
      {
        worktreeDir,
        bareRepoPath: this.bareRepoPath,
        readMetadataOwner: (name) => this.readWorktreeMetadataOwner(name),
      },
    );
    return this.pathResolution.getBranchWorktreePath(this.config.worktreeDir, branchName, naming);
  }

  async updateRef(refName: string, sha: string): Promise<void> {
    return this.branchRefs.updateRef(refName, sha);
  }

  async deleteRef(refName: string): Promise<void> {
    return this.branchRefs.deleteRef(refName);
  }

  async listRefs(prefix: string): Promise<string[]> {
    return this.branchRefs.listRefs(prefix);
  }

  async getLocalBranchCommit(branchName: string): Promise<string | null> {
    return this.branchRefs.getLocalBranchCommit(branchName);
  }

  async createBranchAt(branchName: string, sha: string): Promise<void> {
    return this.branchRefs.createBranchAt(branchName, sha);
  }

  async deleteLocalBranch(branchName: string): Promise<void> {
    return this.branchRefs.deleteLocalBranch(branchName);
  }

  async deleteLocalBranchIfAt(branchName: string, expectedOid: string): Promise<void> {
    return this.branchRefs.deleteLocalBranchIfAt(branchName, expectedOid);
  }

  async createBundleFromRef(bundlePath: string, refName: string): Promise<boolean> {
    return this.branchRefs.createBundleFromRef(bundlePath, refName);
  }

  async countCommitsNotOnAnyRemote(rev: string): Promise<number> {
    return this.branchRefs.countCommitsNotOnAnyRemote(rev);
  }

  async getRemoteCommit(ref: string): Promise<string> {
    return this.branchRefs.getRemoteCommit(ref);
  }

  async branchExists(branchName: string): Promise<{ local: boolean; remote: boolean }> {
    return this.branchRefs.branchExists(branchName);
  }

  async trackRemoteBranchIfExists(branchName: string, worktreePath: string): Promise<boolean> {
    return this.branchRefs.trackRemoteBranchIfExists(branchName, worktreePath);
  }

  async createBranch(branchName: string, baseBranch: string): Promise<void> {
    return this.branchRefs.createBranch(branchName, baseBranch);
  }

  async pushBranch(branchName: string): Promise<void> {
    return this.branchRefs.pushBranch(branchName);
  }

  async checkWorktreeStatus(worktreePath: string): Promise<boolean> {
    return this.statusService.checkWorktreeStatus(worktreePath);
  }

  async hasStashedChanges(worktreePath: string): Promise<boolean> {
    return this.statusService.hasStashedChanges(worktreePath);
  }

  async getFullWorktreeStatus(
    worktreePath: string,
    includeDetails = false,
    refScans?: RefScanScope,
    { readOnly = false }: { readOnly?: boolean } = {},
  ): Promise<WorktreeStatusResult> {
    const metadata = await this.getWorktreeMetadata(worktreePath);
    const statusService = readOnly ? this.getProbeStatusService() : this.statusService;
    return statusService.getFullWorktreeStatus(worktreePath, includeDetails, {
      lastSyncCommit: metadata?.lastSyncCommit,
      lastKnownRemoteTip: metadata?.lastKnownRemoteTip,
      refScans,
    });
  }

  private getProbeStatusService(): WorktreeStatusService {
    if (this.baseEnv[ENV_CONSTANTS.GIT_OPTIONAL_LOCKS] === "0") return this.statusService;
    this.probeStatusService ??= new WorktreeStatusService(
      {
        skipLfs: this.config.skipLfs,
        maxConcurrentGitProcesses: this.config.parallelism?.maxStatusChecks,
        extraEnv: { [ENV_CONSTANTS.GIT_OPTIONAL_LOCKS]: "0" },
      },
      this.logger,
    );
    return this.probeStatusService;
  }

  async getRemoteBranchTips(): Promise<Map<string, string>> {
    return this.branchRefs.readRemoteBranchTips(this.getGit());
  }

  async recordRemoteTip(worktreePath: string, branchName: string, oid: string): Promise<void> {
    await this.metadataService.recordRemoteTip(
      this.bareRepoPath,
      worktreePath,
      `${GIT_CONSTANTS.REMOTE_PREFIX}${branchName}`,
      oid,
    );
  }

  async hasOperationInProgress(worktreePath: string): Promise<boolean> {
    return this.statusService.hasOperationInProgress(worktreePath);
  }

  setLfsSkipEnabled(value: boolean): void {
    this.lfsSkipOverride = value;
  }

  isLfsSkipEnabled(): boolean {
    return this.config.skipLfs || this.lfsSkipOverride;
  }

  async getAheadBehindCounts(worktreePath: string, branch: string): Promise<AheadBehindCounts> {
    const worktreeGit = this.getCachedGit(worktreePath);
    const output = await worktreeGit.raw([
      "rev-list",
      "--left-right",
      "--count",
      `HEAD...${GIT_CONSTANTS.REFS.REMOTES}/${branch}`,
    ]);
    const counts = output.trim().split(/\s+/);
    const ahead = Number.parseInt(counts[0] ?? "", 10);
    const behind = Number.parseInt(counts[1] ?? "", 10);
    if (counts.length !== 2 || Number.isNaN(ahead) || Number.isNaN(behind)) {
      throw new GitOperationError(
        "rev-list",
        `unexpected ahead/behind output for '${branch}' in '${worktreePath}': ${JSON.stringify(output)}`,
      );
    }
    return { ahead, behind };
  }

  async updateWorktree(worktreePath: string, branch: string): Promise<WorktreeUpdateResult> {
    const worktreeGit = this.getCachedGit(worktreePath, this.isLfsSkipEnabled());

    const before = (await worktreeGit.revparse(["HEAD"])).trim();
    try {
      await worktreeGit.merge([`origin/${branch}`, "--ff-only"]);
    } catch (error) {
      const message = getErrorMessage(error);
      if (!ERROR_MESSAGES.FAST_FORWARD_FAILED.some((msg) => message.includes(msg))) {
        const host = {
          logger: this.logger,
          repoName: worktreePath,
          emitProgress: (e: GitProgressEvent) => this.progressEmitter?.(e),
        };
        await undoRejectedFastForwardIn(host, worktreeGit, worktreePath, branch, before);
      }
      throw error;
    }
    const after = (await worktreeGit.revparse(["HEAD"])).trim();
    const updated = after !== before;

    if (updated) {
      try {
        await this.metadataService.updateLastSyncFromPath(this.bareRepoPath, worktreePath, after);
      } catch (metadataError) {
        this.logger.warn(`Failed to update metadata for worktree: ${String(metadataError)}`);
      }
    }

    return { updated, before, after };
  }

  async classifyRemoteRelationship(
    worktreePath: string,
    branch: string,
    localRef = "HEAD",
  ): Promise<RemoteRelationship> {
    const worktreeGit = this.getCachedGit(worktreePath);
    const remoteRef = `refs/remotes/origin/${branch}`;

    let localSha: string;
    let remoteSha: string;
    try {
      localSha = (await worktreeGit.revparse([localRef])).trim();
      remoteSha = (await worktreeGit.revparse([remoteRef])).trim();
    } catch {
      return "diverged";
    }

    if (localSha === remoteSha) return "up_to_date";

    let mergeBase = "";
    let mergeBaseFailed = false;
    try {
      mergeBase = (await worktreeGit.raw(["merge-base", localRef, remoteRef])).trim();
    } catch {
      mergeBaseFailed = true;
    }
    if (mergeBaseFailed || !mergeBase) {
      if (await this.isShallowRepository(worktreeGit)) return "indeterminate_shallow";
      return "diverged";
    }
    if (mergeBase === localSha) return "fast_forward";
    if (mergeBase === remoteSha) return "local_ahead";
    return "diverged";
  }

  private async isShallowRepository(git: SimpleGit): Promise<boolean> {
    try {
      const output = await git.raw(["rev-parse", "--is-shallow-repository"]);
      return output.trim() === "true";
    } catch {
      return false;
    }
  }

  async getChangedPathsInRange(worktreePath: string, fromRef: string, toRef: string): Promise<string[] | null> {
    const worktreeGit = this.getCachedGit(worktreePath);
    try {
      const out = await worktreeGit.raw([
        "-c",
        "core.quotePath=false",
        "diff",
        "--name-only",
        "--no-renames",
        `${fromRef}..${toRef}`,
      ]);
      return out
        .split("\n")
        .map((l) => l.replace(/\r$/, ""))
        .filter((l) => l.length > 0);
    } catch (error) {
      this.logger.warn(`Failed to compute diff ${fromRef}..${toRef} in ${worktreePath}: ${getErrorMessage(error)}`);
      return null;
    }
  }

  async compareTreeContent(worktreePath: string, branch: string): Promise<boolean> {
    const worktreeGit = this.getCachedGit(worktreePath);
    try {
      const localTree = await worktreeGit.raw(["rev-parse", "HEAD^{tree}"]);
      const remoteTree = await worktreeGit.raw(["rev-parse", `origin/${branch}^{tree}`]);

      return localTree.trim() === remoteTree.trim();
    } catch (error) {
      this.logger.error(`Error comparing tree content: ${String(error)}`);
      return false;
    }
  }

  private wouldOverwriteIgnoredPaths(ignoredRaw: string, upstreamRaw: string): boolean {
    const upstreamFiles = new Set<string>();
    const upstreamPaths = new Set<string>();
    for (const upstreamPath of upstreamRaw.split("\0")) {
      if (!upstreamPath) continue;
      upstreamFiles.add(upstreamPath);
      upstreamPaths.add(upstreamPath);
      for (let slash = upstreamPath.indexOf("/"); slash !== -1; slash = upstreamPath.indexOf("/", slash + 1)) {
        upstreamPaths.add(upstreamPath.slice(0, slash));
      }
    }

    for (const entry of ignoredRaw.split("\0")) {
      if (!entry) continue;
      const localPath = entry.endsWith("/") ? entry.slice(0, -1) : entry;
      if (upstreamPaths.has(localPath)) return true;
      for (let slash = localPath.indexOf("/"); slash !== -1; slash = localPath.indexOf("/", slash + 1)) {
        if (upstreamFiles.has(localPath.slice(0, slash))) return true;
      }
    }
    return false;
  }

  async resetToUpstream(worktreePath: string, branch: string, expectedHead?: string): Promise<boolean> {
    const worktreeGit = this.getCachedGit(worktreePath, this.isLfsSkipEnabled());
    const status = await worktreeGit.status(["--ignore-submodules=none"]);
    if (!status.isClean()) return false;

    const [ignoredRaw, upstreamRaw] = await Promise.all([
      worktreeGit.raw([
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "--no-empty-directory",
      ]),
      worktreeGit.raw(["ls-tree", "-rz", "--name-only", `origin/${branch}`]),
    ]);
    if (this.wouldOverwriteIgnoredPaths(ignoredRaw, upstreamRaw)) return false;

    if (expectedHead) {
      const currentHead = (await worktreeGit.revparse(["HEAD"])).trim();
      if (currentHead !== expectedHead) return false;
    }

    try {
      await worktreeGit.raw(["checkout", "-B", branch, `origin/${branch}`, "--no-overwrite-ignore"]);
    } catch (error) {
      if (/would be overwritten by checkout/i.test(getErrorMessage(error))) return false;
      throw error;
    }

    try {
      const currentCommit = await worktreeGit.revparse(["HEAD"]);
      await this.metadataService.updateLastSyncFromPath(this.bareRepoPath, worktreePath, currentCommit.trim());
    } catch (metadataError) {
      this.logger.warn(`Failed to update metadata after reset: ${String(metadataError)}`);
    }
    return true;
  }

  async getCurrentCommit(worktreePath: string): Promise<string> {
    const worktreeGit = this.getCachedGit(worktreePath);
    const commit = await worktreeGit.revparse(["HEAD"]);
    return commit.trim();
  }

  async getWorktreeMetadata(worktreePath: string): Promise<SyncMetadata | null> {
    if (this.bareRepoPathOrNull === null) return null;
    return this.metadataService.loadMetadataFromPath(this.bareRepoPathOrNull, worktreePath);
  }
}
