import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";

import { DEFAULT_CONFIG, ENV_CONSTANTS, PATH_CONSTANTS } from "../constants";
import { ConfigError, FastForwardError, GitOperationError, WorktreeNotCleanError } from "../errors";
import { fileExists } from "../utils/file-exists";
import { makeGitProgressHandler } from "../utils/git-progress";
import { normalizeRepoUrlForComparison } from "../utils/git-url";
import { getErrorMessage, isLfsError, isMissingRemoteRefError } from "../utils/lfs-error";

import { BranchCreatedActionsService } from "./branch-created-actions.service";
import { cloneSkipToOutcomeAction } from "./sync-outcome";

import type { GitService } from "./git.service";
import type { Logger } from "./logger.service";
import type { SyncOutcomeAccumulator } from "./sync-outcome";
import type { Config, RepositoryConfig } from "../types";
import type { GitProgressEmitter, GitProgressEvent } from "../utils/git-progress";
import type { SimpleGit, SimpleGitOptions } from "simple-git";

const SHALLOW_RELATION_DEEPEN_TARGETS = [50, 200, 1000] as const;

export type CloneSkipReason =
  | { kind: "branch_mismatch"; phase: "init" | "sync"; currentBranch: string; expectedBranch: string }
  | { kind: "head_unreadable"; phase: "init" | "sync"; error: string }
  | { kind: "dirty_tree" }
  | { kind: "diverged"; branch: string }
  | { kind: "ahead_unpushed"; branch: string }
  | { kind: "missing_remote_ref"; branch: string; source: "fetch_error" | "post_fetch_verify" }
  | { kind: "indeterminate_shallow"; branch: string; deepenedTo: number | null }
  | { kind: "origin_mismatch"; actual: string; expected: string };

export type CloneSkipListener = (reason: CloneSkipReason) => void;

export class CloneSyncService {
  private initialized = false;
  private resolvedBranch: string | null = null;
  private branchCreatedActions: BranchCreatedActionsService;
  private progressEmitter?: GitProgressEmitter;
  private onSkip?: CloneSkipListener;
  private outcomeAccumulator?: SyncOutcomeAccumulator;
  // One-shot suppression token. When init records a wrong-branch / unreadable-HEAD
  // skip for an existing clone, it sets this so the immediately following
  // runSyncAttempt (same sync operation) does not record the identical skip again.
  private pendingInitSkip: CloneSkipReason | null = null;

  constructor(
    private config: Config,
    private gitService: GitService,
    private logger: Logger,
    options: {
      branchCreatedActions?: BranchCreatedActionsService;
      progressEmitter?: GitProgressEmitter;
      onSkip?: CloneSkipListener;
    } = {},
  ) {
    this.branchCreatedActions = options.branchCreatedActions ?? new BranchCreatedActionsService();
    this.progressEmitter = options.progressEmitter;
    this.onSkip = options.onSkip;
  }

  updateLogger(logger: Logger): void {
    this.logger = logger;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  clearPendingInitSkip(): void {
    this.pendingInitSkip = null;
  }

  async getWorktrees(): Promise<Array<{ path: string; branch: string }>> {
    const worktreeDir = path.resolve(this.config.worktreeDir);
    if (!(await fileExists(path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR)))) {
      return [];
    }

    const git = this.clientFor(worktreeDir, this.getFetchTimeoutMs());
    let branch = (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();

    if (!branch || branch === "HEAD") {
      const head = (await git.raw(["rev-parse", "--short", "HEAD"])).trim();
      branch = head ? `(detached ${head})` : "(detached)";
    }

    return [{ path: worktreeDir, branch }];
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

  private async withOutcome<T>(outcome: SyncOutcomeAccumulator | undefined, operation: () => Promise<T>): Promise<T> {
    const previousOutcome = this.outcomeAccumulator;
    if (outcome) {
      this.outcomeAccumulator = outcome;
    }

    try {
      return await operation();
    } finally {
      if (outcome) {
        this.outcomeAccumulator = previousOutcome;
      }
    }
  }

  private recordSkip(
    reason: CloneSkipReason,
    logMessage: string,
    progressMessage?: string,
    logLevel: "warn" | "info" = "warn",
  ): void {
    if (logLevel === "warn") {
      this.logger.warn(logMessage);
    } else {
      this.logger.info(logMessage);
    }
    this.emitProgress({ phase: "skip", message: progressMessage ?? logMessage });
    try {
      this.onSkip?.(reason);
    } catch {
      // listeners must not break sync flow
    }
    this.outcomeAccumulator?.add(
      cloneSkipToOutcomeAction(reason, {
        branch: this.resolvedBranch ?? this.config.branch,
        path: this.config.worktreeDir,
      }),
    );
  }

  private clientFor(dir: string, blockMs: number): SimpleGit {
    return simpleGit(dir, this.buildGitOptions(blockMs)).env(this.buildGitEnv());
  }

  // Force a stable C locale so git's stderr is deterministic English. The
  // missing-remote-ref and LFS error classification matches on those strings
  // and would otherwise misfire under a non-English LANG/LC_ALL. simple-git's
  // .env() merges this object with process.env (PATH etc. preserved).
  private buildGitEnv(opts: { forceLfsSkip?: boolean } = {}): Record<string, string> {
    const env: Record<string, string> = { LC_ALL: "C", LANG: "C" };
    if (opts.forceLfsSkip || this.isLfsSkipEnabled()) {
      env[ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE] = "1";
    }
    return env;
  }

  private buildCloneArgs(branch: string): string[] {
    const args = ["--branch", branch, "--single-branch", "--no-tags", "--progress"];
    if (this.config.depth !== undefined) {
      args.push("--depth", String(this.config.depth));
    }
    return args;
  }

  private getBranchRefspec(branch: string): string {
    return `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
  }

  private async buildFetchArgs(git: SimpleGit, branch: string): Promise<string[]> {
    const args = ["origin", "--prune", "--no-tags", "--progress"];
    if (this.config.depth !== undefined && (await this.isShallowRepository(git))) {
      args.push("--depth", String(this.config.depth));
    }
    args.push(this.getBranchRefspec(branch));
    return args;
  }

  private async configureSingleBranchRemote(git: SimpleGit, branch: string): Promise<void> {
    await git.raw(["config", "--replace-all", "remote.origin.fetch", this.getBranchRefspec(branch)]);
    await git.raw(["config", "--replace-all", "remote.origin.tagOpt", "--no-tags"]);
    await this.deleteStaleRemoteTrackingRefs(git, branch);
  }

  private recordMissingRemoteRefSkip(branch: string): void {
    this.recordSkip(
      { kind: "missing_remote_ref", branch, source: "fetch_error" },
      `Tracked branch '${branch}' is missing on remote for '${this.repoName}'. Skipping sync.`,
      `Skipping '${this.repoName}': origin/${branch} is missing`,
    );
  }

  private async fetchWithRecovery(
    git: SimpleGit,
    fetchArgs: string[],
    worktreeDir: string,
    branch: string,
  ): Promise<{ skipped: boolean }> {
    try {
      await git.fetch(fetchArgs);
      return { skipped: false };
    } catch (fetchError) {
      const message = getErrorMessage(fetchError);
      if (isLfsError(message)) {
        this.logger.info(`⚠️  LFS error during fetch for '${this.repoName}'; retrying with LFS disabled.`);
        this.emitProgress({ phase: "fetch", message: `Retrying fetch for '${this.repoName}' with LFS disabled` });
        const lfsSkipGit = simpleGit(worktreeDir, this.buildGitOptions(this.getFetchTimeoutMs())).env(
          this.buildGitEnv({ forceLfsSkip: true }),
        );
        try {
          await lfsSkipGit.fetch(fetchArgs);
          return { skipped: false };
        } catch (retryError) {
          // The LFS-disabled retry can itself hit a deleted remote branch —
          // classify it as a soft skip too, instead of letting it escape as a
          // hard failure.
          if (isMissingRemoteRefError(getErrorMessage(retryError))) {
            this.recordMissingRemoteRefSkip(branch);
            return { skipped: true };
          }
          // Otherwise propagate the retry error unchanged so the outer retry
          // policy's LFS handling still sees an accurate error.
          throw retryError;
        }
      }
      if (isMissingRemoteRefError(message)) {
        this.recordMissingRemoteRefSkip(branch);
        return { skipped: true };
      }
      throw fetchError;
    }
  }

  private async hasRemoteBranch(git: SimpleGit, branch: string): Promise<boolean> {
    try {
      // simple-git resolves `show-ref --quiet` even when git exits 1, so keep
      // stdout enabled (no --quiet) to get a real reject on a missing ref —
      // otherwise the post-fetch missing_remote_ref skip would never fire.
      await git.raw(["show-ref", "--verify", `refs/remotes/origin/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async isShallowRepository(git: SimpleGit): Promise<boolean> {
    try {
      const output = await git.raw(["rev-parse", "--is-shallow-repository"]);
      return output.trim() === "true";
    } catch {
      return false;
    }
  }

  private async unshallowIfDepthRemoved(git: SimpleGit): Promise<void> {
    if (this.config.depth !== undefined) return;

    if (!(await this.isShallowRepository(git))) return;

    this.logger.info(
      `[deepen] Existing shallow clone for '${this.repoName}' has no configured depth; fetching full history...`,
    );
    await git.fetch(["--unshallow", "--no-tags"]);
  }

  private getDeepenTargets(): readonly number[] {
    const configuredDepth = this.config.depth;
    if (configuredDepth === undefined) return [];
    // `git fetch --depth N` can shorten a shallow repo if N is below current depth.
    // Skip targets at or below the configured depth — they would never widen history.
    return SHALLOW_RELATION_DEEPEN_TARGETS.filter((target) => target > configuredDepth);
  }

  private async deepenShallowHistoryToDepth(git: SimpleGit, branch: string, targetDepth: number): Promise<void> {
    this.logger.info(
      `[deepen] Shallow clone for '${this.repoName}' lacks enough history to classify origin/${branch}; ` +
        `refetching to depth ${targetDepth} before deciding.`,
    );
    this.emitProgress({
      phase: "fetch",
      message: `Deepening '${this.repoName}' to depth ${targetDepth} before classifying origin/${branch}`,
    });
    await git.fetch([
      "origin",
      "--depth",
      String(targetDepth),
      "--prune",
      "--no-tags",
      "--progress",
      this.getBranchRefspec(branch),
    ]);
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

  private parseLsRemoteHeads(output: string): string[] {
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[1] ?? "")
      .filter((ref) => ref.startsWith("refs/heads/"))
      .map((ref) => ref.slice("refs/heads/".length))
      .filter((branch) => branch.length > 0);
  }

  async getRemoteBranches(): Promise<string[]> {
    const worktreeDir = path.resolve(this.config.worktreeDir);
    const repoArg = (await fileExists(path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR))) ? "origin" : this.config.repoUrl;
    const git =
      repoArg === "origin"
        ? this.clientFor(worktreeDir, this.getFetchTimeoutMs())
        : simpleGit(this.buildGitOptions(this.getFetchTimeoutMs())).env(this.buildGitEnv());
    const output = await git.raw(["ls-remote", "--heads", repoArg]);
    return this.parseLsRemoteHeads(output);
  }

  private async localBranchExists(git: SimpleGit, branch: string): Promise<boolean> {
    try {
      await git.raw(["show-ref", "--verify", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async localBranchCanFastForward(git: SimpleGit, branch: string): Promise<boolean> {
    const localRef = `refs/heads/${branch}`;
    const remoteRef = `refs/remotes/origin/${branch}`;
    let localSha: string;
    let remoteSha: string;
    try {
      localSha = (await git.raw(["rev-parse", localRef])).trim();
      remoteSha = (await git.raw(["rev-parse", remoteRef])).trim();
    } catch {
      return false;
    }

    if (localSha === remoteSha) return true;

    try {
      const mergeBase = (await git.raw(["merge-base", localRef, remoteRef])).trim();
      return mergeBase === localSha;
    } catch {
      return false;
    }
  }

  private async deleteRemoteTrackingRef(git: SimpleGit, refName: string): Promise<void> {
    try {
      await git.raw(["update-ref", "-d", refName]);
    } catch {
      // Stale remote refs are best-effort cleanup; sync correctness comes from the narrowed refspec.
    }
  }

  private async deleteStaleRemoteTrackingRefs(git: SimpleGit, branch: string): Promise<void> {
    let refsOutput: string;
    try {
      refsOutput = await git.raw(["for-each-ref", "--format=%(refname)", "refs/remotes/origin"]);
    } catch {
      return;
    }

    const keepRef = `refs/remotes/origin/${branch}`;
    const refsToDelete = refsOutput
      .split(/\r?\n/)
      .map((ref) => ref.trim())
      .filter((ref) => ref && ref !== keepRef && ref !== "refs/remotes/origin/HEAD");

    for (const ref of refsToDelete) {
      await this.deleteRemoteTrackingRef(git, ref);
    }
  }

  private async restoreBranchAfterCheckoutFailure(
    git: SimpleGit,
    previousBranch: string,
    attemptedBranch: string,
  ): Promise<void> {
    if (!previousBranch || previousBranch === "HEAD" || previousBranch === attemptedBranch) return;

    try {
      await git.raw(["switch", previousBranch]);
    } catch (error) {
      this.logger.warn(
        `Failed to restore '${this.repoName}' to '${previousBranch}' after checkout failure: ${getErrorMessage(error)}`,
      );
    }
  }

  async checkoutBranch(branch: string): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    const worktreeDir = this.config.worktreeDir;
    const git = this.clientFor(worktreeDir, this.getFetchTimeoutMs());
    const originMismatch = await this.evaluateOriginMatch(git, worktreeDir);
    if (originMismatch) {
      throw new ConfigError(
        `Cannot switch '${this.repoName}' to '${branch}': ${originMismatch.progressDetail}.`,
        "ORIGIN_MISMATCH",
      );
    }

    const currentBranch = (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (currentBranch === branch) {
      await this.configureSingleBranchRemote(git, branch);
      this.resolvedBranch = branch;
      this.pendingInitSkip = null;
      return;
    }

    const isClean = await this.gitService.checkWorktreeStatus(worktreeDir);
    if (!isClean) {
      throw new WorktreeNotCleanError(worktreeDir, ["working tree has local changes"]);
    }

    // Converge shallow state like runSyncAttempt does: with no configured depth an
    // existing shallow clone is unshallowed before the branch fetch, so switching
    // branches doesn't leave the new branch shallow while the rest is full.
    await this.unshallowIfDepthRemoved(git);

    const fetchArgs = await this.buildFetchArgs(git, branch);
    if ((await this.fetchWithRecovery(git, fetchArgs, worktreeDir, branch)).skipped) {
      throw new GitOperationError("checkout", `origin/${branch} is missing for '${this.repoName}'`);
    }

    if (await this.localBranchExists(git, branch)) {
      if (!(await this.localBranchCanFastForward(git, branch))) {
        throw new FastForwardError(branch);
      }

      let switched = false;
      try {
        await git.raw(["switch", branch]);
        switched = true;
        await git.merge([`origin/${branch}`, "--ff-only"]);
      } catch (error) {
        if (switched) {
          await this.restoreBranchAfterCheckoutFailure(git, currentBranch, branch);
        }
        throw error;
      }
    } else {
      await git.raw(["switch", "-c", branch, "--track", `origin/${branch}`]);
    }

    await this.configureSingleBranchRemote(git, branch);
    this.resolvedBranch = branch;
    this.pendingInitSkip = null;
  }

  async initialize(outcome?: SyncOutcomeAccumulator): Promise<void> {
    return this.withOutcome(outcome, () => this.initializeInternal());
  }

  private async initializeInternal(): Promise<void> {
    this.pendingInitSkip = null;
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
      const result = await this.validateExistingClone(branch);
      if (!result.valid) {
        this.recordSkip(result.skip, result.warnMessage, `Skipping '${this.repoName}': ${result.progressDetail}`);
        this.pendingInitSkip = result.skip;
        this.initialized = true;
        return;
      }
      const git = this.clientFor(worktreeDir, this.getFetchTimeoutMs());
      await this.configureSingleBranchRemote(git, branch);
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

    const cloneClient = simpleGit(this.buildGitOptions(this.getCloneTimeoutMs())).env(this.buildGitEnv());

    try {
      await cloneClient.clone(this.config.repoUrl, worktreeDir, this.buildCloneArgs(branch));
    } catch (error) {
      await this.maybeCleanupPartialClone(worktreeDir, cloneCreatedDir);
      this.outcomeAccumulator?.recordFailed("repo", getErrorMessage(error), {
        reason: "clone_failed",
        branch,
        path: worktreeDir,
      });
      throw error;
    }

    const worktreeGit = this.clientFor(worktreeDir, this.getFetchTimeoutMs());
    await this.configureSingleBranchRemote(worktreeGit, branch);

    this.logger.info(`✅ Clone successful.`);
    this.emitProgress({ phase: "clone", message: `Clone successful for '${this.repoName}'` });

    if (this.config.sparseCheckout) {
      this.logger.info(`Applying sparse-checkout patterns to '${worktreeDir}'...`);
      this.emitProgress({ phase: "sparse_checkout", message: `Applying sparse-checkout for '${this.repoName}'` });
      const sparseService = this.gitService.getSparseCheckoutService();
      await sparseService.applyToWorktree(worktreeDir, this.config.sparseCheckout);
      await worktreeGit.raw(["checkout", "HEAD"]);
      this.emitProgress({ phase: "sparse_checkout", message: `Sparse-checkout applied for '${this.repoName}'` });
    }

    this.emitProgress({ phase: "lfs", message: `Verifying LFS for '${this.repoName}'` });
    await this.gitService.verifyLfs(worktreeDir, branch);
    this.emitProgress({ phase: "lfs", message: `LFS verified for '${this.repoName}'` });

    await this.runInitialFileCopy(worktreeDir, branch);

    // Only record `created` once init is fully complete; otherwise an aborted
    // post-clone step would leave the outcome reporting both created and failed.
    this.outcomeAccumulator?.recordCreated(branch, worktreeDir);
    this.initialized = true;
  }

  // Detects an on-disk clone whose `origin` no longer matches the configured
  // repoUrl (e.g. repoUrl was repointed in config). Returns a skip descriptor so
  // we never fetch/ff-merge from the wrong remote; null when origin matches or
  // can't be read. Comparison is normalized so https/.git/trailing-slash
  // variants don't false-positive; the raw URLs are kept in the message.
  private async evaluateOriginMatch(
    git: SimpleGit,
    worktreeDir: string,
  ): Promise<{ skip: CloneSkipReason; warnMessage: string; progressDetail: string } | null> {
    let originUrl: string;
    try {
      originUrl = (await git.raw(["remote", "get-url", "origin"])).trim();
    } catch {
      this.logger.warn(`Could not read 'origin' remote URL from existing clone at '${worktreeDir}'.`);
      return null;
    }

    if (!originUrl || normalizeRepoUrlForComparison(originUrl) === normalizeRepoUrlForComparison(this.config.repoUrl)) {
      return null;
    }

    return {
      skip: { kind: "origin_mismatch", actual: originUrl, expected: this.config.repoUrl },
      warnMessage:
        `Existing clone at '${worktreeDir}' has origin '${originUrl}', expected '${this.config.repoUrl}'. ` +
        `Update the remote ('git remote set-url origin <url>') or point worktreeDir at a fresh path.`,
      progressDetail: `origin '${originUrl}' is not '${this.config.repoUrl}'`,
    };
  }

  private async validateExistingClone(
    expectedBranch: string,
  ): Promise<{ valid: true } | { valid: false; skip: CloneSkipReason; warnMessage: string; progressDetail: string }> {
    const worktreeDir = this.config.worktreeDir;
    const git = this.clientFor(worktreeDir, this.getFetchTimeoutMs());

    const originMismatch = await this.evaluateOriginMatch(git, worktreeDir);
    if (originMismatch) {
      return { valid: false, ...originMismatch };
    }

    let currentBranch: string;
    try {
      currentBranch = (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      return {
        valid: false,
        skip: { kind: "head_unreadable", phase: "init", error: errorMessage },
        warnMessage: `Existing clone at '${worktreeDir}' has a .git folder but reading HEAD failed: ${errorMessage}`,
        progressDetail: `could not read HEAD (${errorMessage})`,
      };
    }

    if (currentBranch !== expectedBranch) {
      return {
        valid: false,
        skip: {
          kind: "branch_mismatch",
          phase: "init",
          currentBranch,
          expectedBranch,
        },
        warnMessage:
          `Existing clone at '${worktreeDir}' is on branch '${currentBranch}', expected '${expectedBranch}'. ` +
          `Switch the working tree to '${expectedBranch}' or update the config.`,
        progressDetail: `current branch '${currentBranch}' is not '${expectedBranch}'`,
      };
    }

    return { valid: true };
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

  async runSyncAttempt(outcome?: SyncOutcomeAccumulator): Promise<void> {
    return this.withOutcome(outcome, () => this.runSyncAttemptInternal());
  }

  private async runSyncAttemptInternal(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
      // init ran here and recorded any skip itself; no duplicate to suppress.
      this.pendingInitSkip = null;
      return;
    }

    // If init already recorded a wrong-branch / unreadable-HEAD skip for the
    // current clone state during this same sync operation, don't record it a
    // second time. Consume the one-shot token; later ticks re-evaluate fresh.
    if (this.pendingInitSkip) {
      this.pendingInitSkip = null;
      return;
    }

    const branch = await this.resolveBranch();
    const worktreeDir = this.config.worktreeDir;
    const git = this.clientFor(worktreeDir, this.getFetchTimeoutMs());

    let currentBranch: string;
    try {
      currentBranch = (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.recordSkip(
        { kind: "head_unreadable", phase: "sync", error: errorMessage },
        `Could not read current branch from '${worktreeDir}': ${errorMessage}`,
        `Skipping '${this.repoName}': could not read current branch`,
      );
      return;
    }

    if (currentBranch !== branch) {
      this.recordSkip(
        { kind: "branch_mismatch", phase: "sync", currentBranch, expectedBranch: branch },
        `Clone at '${worktreeDir}' is on '${currentBranch}', expected '${branch}'. Skipping fetch+merge.`,
        `Skipping '${this.repoName}': current branch '${currentBranch}' is not '${branch}'`,
      );
      return;
    }

    // Re-check every tick (not just at init): the daemon reuses this service, so
    // a clone whose origin no longer matches repoUrl must keep being skipped
    // rather than fetching from the wrong remote.
    const originMismatch = await this.evaluateOriginMatch(git, worktreeDir);
    if (originMismatch) {
      this.recordSkip(
        originMismatch.skip,
        originMismatch.warnMessage,
        `Skipping '${this.repoName}': ${originMismatch.progressDetail}`,
      );
      return;
    }

    await this.unshallowIfDepthRemoved(git);

    await this.configureSingleBranchRemote(git, branch);

    const fetchArgs = await this.buildFetchArgs(git, branch);
    this.emitProgress({ phase: "fetch", message: `Fetching origin/${branch} for '${this.repoName}'` });
    if ((await this.fetchWithRecovery(git, fetchArgs, worktreeDir, branch)).skipped) {
      return;
    }
    this.emitProgress({ phase: "fetch", message: `Fetched origin/${branch} for '${this.repoName}'` });

    if (!(await this.hasRemoteBranch(git, branch))) {
      this.recordSkip(
        { kind: "missing_remote_ref", branch, source: "post_fetch_verify" },
        `Tracked branch '${branch}' is missing on remote for '${this.repoName}'. Skipping sync.`,
        `Skipping '${this.repoName}': origin/${branch} is missing`,
      );
      return;
    }

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
      this.recordSkip(
        { kind: "dirty_tree" },
        `⏭️  Skipping ff-merge for '${this.repoName}' — working tree has local changes.`,
        `Skipping merge for '${this.repoName}': working tree has local changes`,
        "info",
      );
      return;
    }

    let relationship = await this.gitService.classifyRemoteRelationship(worktreeDir, branch);
    let lastDeepenedTo: number | null = null;
    if (relationship === "indeterminate_shallow") {
      for (const target of this.getDeepenTargets()) {
        await this.deepenShallowHistoryToDepth(git, branch, target);
        lastDeepenedTo = target;
        relationship = await this.gitService.classifyRemoteRelationship(worktreeDir, branch);
        if (relationship !== "indeterminate_shallow") break;
      }
    }

    if (relationship === "up_to_date") {
      this.logger.info(`'${this.repoName}' already up to date with origin/${branch}.`);
      this.emitProgress({
        phase: "skip",
        message: `'${this.repoName}' already up to date with origin/${branch}`,
      });
      this.outcomeAccumulator?.recordNoop("repo", "already_up_to_date", {
        branch,
        path: worktreeDir,
        message: `Already up to date with origin/${branch}`,
      });
      return;
    }

    if (relationship !== "fast_forward") {
      if (relationship === "local_ahead") {
        this.recordSkip(
          { kind: "ahead_unpushed", branch },
          `⏭️  '${this.repoName}' has unpushed commits ahead of origin/${branch}. Skipping merge.`,
          `Skipping merge for '${this.repoName}': unpushed commits ahead of origin/${branch}`,
          "info",
        );
      } else if (relationship === "indeterminate_shallow") {
        const detail =
          lastDeepenedTo === null
            ? `no deepening attempted (configured depth already at or above all deepen targets)`
            : `deepening to ${lastDeepenedTo} commits`;
        const progressDetail =
          lastDeepenedTo === null
            ? `no deepening attempted (configured depth at/above limits)`
            : `shallow depth budget exhausted at ${lastDeepenedTo}`;
        this.recordSkip(
          { kind: "indeterminate_shallow", branch, deepenedTo: lastDeepenedTo },
          `⏭️  '${this.repoName}' could not classify origin/${branch} after ${detail}. ` +
            `Skipping merge — consider removing or raising 'depth' to unshallow.`,
          `Skipping merge for '${this.repoName}': ${progressDetail}`,
          "info",
        );
      } else {
        this.recordSkip(
          { kind: "diverged", branch },
          `⏭️  '${this.repoName}' has diverged from origin/${branch}. Skipping merge (no auto-reset).`,
          `Skipping merge for '${this.repoName}': diverged from origin/${branch}`,
          "info",
        );
      }
      return;
    }

    this.logger.info(`Fast-forwarding '${this.repoName}' to origin/${branch}...`);
    this.emitProgress({ phase: "merge", message: `Fast-forwarding '${this.repoName}' to origin/${branch}` });
    await git.merge([`origin/${branch}`, "--ff-only"]);
    this.logger.info(`✅ Updated '${this.repoName}' to origin/${branch}.`);
    this.emitProgress({ phase: "merge", message: `Updated '${this.repoName}' to origin/${branch}` });
    this.outcomeAccumulator?.recordUpdated(branch, worktreeDir, "fast_forward");
  }
}
