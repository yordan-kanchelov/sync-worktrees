import * as path from "path";

import { DEFAULT_CONFIG, ENV_CONSTANTS, ERROR_MESSAGES, GIT_CONSTANTS } from "../constants";
import { GitOperationError, WorktreeError } from "../errors";
import { probePathExists } from "../utils/file-exists";
import { createGitClient } from "../utils/git-client";
import { GitClientCache } from "../utils/git-client-cache";
import { makeGitProgressHandler } from "../utils/git-progress";
import { getDefaultBareRepoDir } from "../utils/git-url";
import { getErrorMessage } from "../utils/errors";
import { isUnitTestShortcutEnabled } from "../utils/unit-test-shortcut";

import { BareRepoService } from "./bare-repo.service";
import { BranchRefService } from "./branch-ref.service";
import { LfsVerificationService } from "./lfs-verification.service";
import { Logger } from "./logger.service";
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
import type { GitProgressEmitter } from "../utils/git-progress";
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

/**
 * Everything sync does with git for one repository, behind one object: the
 * CLI, the TUI, the MCP server and the sync runner all hold a GitService.
 * It owns the per-path client cache, the default branch and its anchor
 * worktree, fetches, and the per-worktree update/reset probes; the larger
 * concerns are delegated to focused services that share its clients and
 * settings through a GitServiceContext:
 *  - BareRepoService: cloning/validating the bare repository, default-branch detection;
 *  - WorktreeCreationService: the worktree-add matrix, rollback, stale-directory quarantine;
 *  - WorktreeRegistryService: `git worktree list`/`remove`;
 *  - BranchRefService: branch and ref probes, creation, deletion, push, bundles;
 *  - LfsVerificationService: checking a checkout materialized its LFS content.
 */
export class GitService {
  private git: SimpleGit | null = null;
  private bareRepoPath: string;
  private mainWorktreePath: string;
  private defaultBranch: string = GIT_CONSTANTS.DEFAULT_BRANCH; // Will be updated after detection
  private metadataService: WorktreeMetadataService;
  private statusService: WorktreeStatusService;
  private sparseCheckoutService: SparseCheckoutService;
  private logger: Logger;
  private lfsSkipOverride = false;
  private gitInstances = new GitClientCache();
  private readonly branchRefs: BranchRefService;
  private readonly registry: WorktreeRegistryService;
  private readonly lfs: LfsVerificationService;
  private readonly bareRepo: BareRepoService;
  private readonly creation: WorktreeCreationService;
  // Environment every client this service builds carries on top of the
  // per-call LFS setting: empty for a syncing service, optional locks off for
  // a read-only one.
  private readonly baseEnv: NodeJS.ProcessEnv;

  constructor(
    private config: GitServiceOptions,
    logger?: Logger,
    private progressEmitter?: GitProgressEmitter,
    options: { readOnly?: boolean } = {},
  ) {
    // A read-only service (the dry run's) must leave the repository exactly as
    // it found it, and `git status` / `git diff` refresh a worktree's index as
    // a side effect unless optional locks are off. Nothing a read-only service
    // runs needs that refresh.
    this.baseEnv = options.readOnly ? { [ENV_CONSTANTS.GIT_OPTIONAL_LOCKS]: "0" } : {};
    this.logger = logger ?? Logger.createDefault(undefined, config.debug);
    this.bareRepoPath = this.config.bareRepoDir || getDefaultBareRepoDir(this.config.repoUrl);
    this.mainWorktreePath = path.join(this.config.worktreeDir, GIT_CONSTANTS.DEFAULT_BRANCH); // Temporary, will be updated
    this.metadataService = new WorktreeMetadataService(this.logger);
    // `maxStatusChecks` is a ceiling on git processes, not on worktrees: the
    // status service shares one budget of that size across every worktree it is
    // asked about, so the prune phase peaks at that many git processes however
    // many stale worktrees a tick turns up.
    this.statusService = new WorktreeStatusService(
      {
        skipLfs: this.config.skipLfs,
        maxConcurrentGitProcesses: this.config.parallelism?.maxStatusChecks,
        ...(options.readOnly && { extraEnv: this.baseEnv }),
      },
      this.logger,
    );
    // `sparse-checkout set` re-materializes everything the pattern list brings
    // into the cone, so it runs the smudge filter just like a checkout does.
    // The service's default factory builds a client with no environment at
    // all, which made `skipLfs: true` (and the per-sync LFS fallback) stop at
    // the sparse step: the very repositories that need LFS skipped failed
    // there instead. Its clients now carry the same LFS setting as every other
    // local command's, resolved per call so the per-sync override counts.
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

  // The view of this service its sub-services work through. Every accessor
  // reads the current value, so updateLogger, a default-branch switch and
  // setLfsSkipEnabled reach them without any re-wiring.
  private createContext(): GitServiceContext {
    return {
      config: this.config,
      bareRepoPath: this.bareRepoPath,
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

  // A client nothing caches: the bare clone (no repository to run in yet),
  // ls-remote against a URL, and one-off environments such as LFS
  // verification's GIT_ATTR_SOURCE.
  private createUncachedGit(dirPath: string | undefined, options: UncachedGitClientOptions): SimpleGit {
    return createGitClient(
      dirPath,
      this.buildGitEnv(options.useLfsSkip, options.extraEnv),
      this.buildSimpleGitOptions(options.blockMs),
    );
  }

  // The environment additions every client of this service carries, for the
  // clients built outside it (clone mode's) that must behave the same way.
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

  // Each path gets one client per (LFS env, kind) combination, and the two
  // kinds differ only in the inactivity timeout: same baseDir, same LFS/env
  // additions, same unsafe allowances. The kind is part of the cache key so a
  // local command can never pick up the network client's kill (or vice versa).
  private getCachedClient(dirPath: string, useLfsSkip: boolean, kind: "local" | "network"): SimpleGit {
    return this.gitInstances.get(dirPath, `${useLfsSkip ? "1" : "0"}::${kind}`, () =>
      createGitClient(
        dirPath,
        this.buildGitEnv(useLfsSkip),
        this.buildSimpleGitOptions(kind === "network" ? this.getFetchTimeoutMs() : 0),
      ),
    );
  }

  // Per-client additions layered over the sanitized process environment by
  // createGitClient, which also forces the C locale every stderr match here
  // ("stale info", missing-ref, LFS) depends on.
  private buildGitEnv(useLfsSkip: boolean, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.baseEnv, ...extra };
    if (useLfsSkip) env[ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE] = "1";
    return env;
  }

  // Every client cached for a path that has stopped being this repository's
  // worktree — removed, moved to trash, quarantined under .removed/, or
  // preserved under .diverged/. Nothing else drops them, so without this a
  // daemon kept every client it ever built (~7 KB apiece, measured: the
  // instance plus its own copy of the sanitized environment) and grew with the
  // repository's branch churn rather than with its worktree count. The status
  // service is cleared alongside this cache — it keys clients by the same
  // paths, and its own removal notice can only come from here.
  //
  // Dropping the entries never disturbs an operation already running on one of
  // those clients — whoever asked for it still holds it.
  private forgetCachedClients(dirPath: string): void {
    this.gitInstances.forget(dirPath);
    this.statusService.forgetWorktree(dirPath);
  }

  // Client for local commands (worktree add/remove/list/prune, merge,
  // checkout, reset, status, ls-files, rev-list/rev-parse, branch,
  // for-each-ref, bundle, ...). No inactivity kill: simple-git's block timeout
  // only resets on stdout/stderr data, and git is legitimately silent for
  // minutes while `worktree add` checks out a large repository (its internal
  // `reset --hard` prints nothing on a pipe) or while LFS smudges files. A
  // silence-based kill there SIGINTs a creation that would have succeeded,
  // on every tick, forever.
  private getCachedGit(dirPath: string, useLfsSkip = false): SimpleGit {
    return this.getCachedClient(dirPath, useLfsSkip, "local");
  }

  // Client for network commands (fetch, push, ls-remote, `remote set-head`).
  // Silence here means a stalled connection or a prompt nobody can answer, so
  // fetchTimeoutMs stays the guard that ends the attempt instead of hanging
  // the sync forever.
  private getCachedNetworkGit(dirPath: string, useLfsSkip = false): SimpleGit {
    return this.getCachedClient(dirPath, useLfsSkip, "network");
  }

  // Progress and inactivity timeout only; createGitClient adds the env and the
  // unsafe-env allowances every client needs. blockMs 0 means no inactivity
  // kill at all (local commands, and the unit-test shortcut).
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

  // Every logger-holding object this service owns, or its lines keep going to
  // the console the TUI has taken over. Cached clients need no rebuild: their
  // progress handlers read `this.logger` per event.
  updateLogger(logger: Logger): void {
    this.logger = logger;
    this.metadataService.updateLogger(logger);
    this.statusService.updateLogger(logger);
    this.sparseCheckoutService.updateLogger(logger);
  }

  async initialize(): Promise<SimpleGit> {
    await this.bareRepo.ensureBareRepository();
    const bareGit = this.getCachedGit(this.bareRepoPath);

    // Always fetch to ensure remote refs are up-to-date
    // This is needed for branch creation UI even when repo already exists
    this.logger.info("Fetching remote branches...");
    await this.getCachedNetworkGit(this.bareRepoPath).fetch(["--all", "--progress"]);

    // Detect the default branch (works from local refs even without fetch)
    this.defaultBranch = await this.bareRepo.detectDefaultBranch(bareGit);
    this.mainWorktreePath = path.join(this.config.worktreeDir, this.defaultBranch);
    await this.ensureMainWorktree(bareGit);

    // Use the main worktree as our primary git instance
    this.git = this.getCachedGit(this.mainWorktreePath);
    return this.git;
  }

  // Makes sure a registered worktree checked out on the default branch exists
  // and leaves mainWorktreePath pointing at it: every fetch runs from there.
  // Resolves to true when this call created the worktree.
  //
  // A registered worktree on the default branch at another path is adopted
  // rather than duplicated: it is the hashed directory the sync created while
  // the branch was an ordinary remote branch, before the remote made it the
  // default, and git refuses a second worktree on a branch that is already
  // checked out.
  private async ensureMainWorktree(bareGit: SimpleGit): Promise<boolean> {
    // Check if main worktree exists
    let needsMainWorktree = true;
    try {
      const worktrees = await this.registry.getWorktreesFromBare(bareGit, true);
      const target = path.resolve(this.mainWorktreePath);
      const registered =
        worktrees.find((w) => path.resolve(w.path) === target) ??
        worktrees.find((w) => w.branch === this.defaultBranch);
      if (registered) {
        const registeredPath = path.resolve(registered.path);
        // A registration whose directory was destroyed out-of-band (rm -rf, a
        // wiped volume) would otherwise satisfy this check forever: the planner
        // never plans a create for the default branch, so nothing else rebuilds
        // it and every sync fails at fetch. Only a definitive "missing" clears
        // the registration — an unverifiable probe keeps it, same rule as
        // dropStaleRegistrations.
        if ((await probePathExists(registeredPath)) === "missing") {
          this.logger.info(
            `${this.defaultBranch} worktree directory is missing at "${registeredPath}"; clearing its stale registration and recreating it.`,
          );
          try {
            await bareGit.raw(["worktree", "remove", "--force", registeredPath]);
            this.forgetCachedClients(registeredPath);
          } catch (removalError) {
            // A locked registration makes single --force fail, which correctly
            // preserves it; leave the old (broken) state rather than guess.
            this.logger.warn(
              `Could not clear stale registration for '${registeredPath}': ${getErrorMessage(removalError)}`,
            );
            needsMainWorktree = false;
          }
        } else {
          if (registeredPath !== target) {
            this.logger.info(
              `${this.defaultBranch} is already checked out at "${registered.path}"; using it as the ${this.defaultBranch} worktree.`,
            );
            this.mainWorktreePath = registered.path;
          }
          needsMainWorktree = false;
        }
      }
    } catch {
      // If worktree list fails, assume we need main worktree
    }

    if (!needsMainWorktree) return false;

    // The default branch is created through the same path as every other
    // branch. A directory already at its path that is not a registered
    // worktree — the checkout left behind after `.bare/` was deleted to
    // recover from corruption, an unrelated directory of the same name — is
    // moved to trash or quarantine first, never adopted: this.git and every
    // later fetch would otherwise run inside a non-repository.
    this.logger.info(`Creating ${this.defaultBranch} worktree at "${this.mainWorktreePath}"...`);
    let created = false;
    try {
      created = (await this.addWorktree(this.defaultBranch, this.mainWorktreePath)).status === "created";
    } catch (error) {
      // A concurrent creator can land between addWorktree's existence probe
      // and git's own check, in which case git reports the path as already
      // existing. That is benign only when the path is a registered worktree
      // now; an unregistered directory stays an error.
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

  // The dry run's stand-in for initialize(): the same bare-repository checks,
  // the same fetch and the same default-branch resolution, with every write
  // initialize() would make left out — no clone, no refspec config, no
  // `remote set-head`, no default-branch worktree created or healed. The one
  // write is the fetch itself, which updates remote-tracking refs (and brings
  // in objects) exactly as the sync's own fetch would.
  //
  // Resolves to `missing` when there is no bare repository yet, decided
  // before anything touches the disk. Otherwise the service is left able to
  // answer the sync runner's reads; `anchorMissing` says the default branch
  // has no worktree, in which case those reads run in the bare repository and
  // a sync would create that worktree first.
  //
  // Only for a service constructed read-only and never used to sync: it marks
  // the service initialized without the repairs initialize() makes.
  async openForPlanning(): Promise<{ state: "missing" } | { state: "ready"; anchorMissing: boolean }> {
    if ((await probePathExists(path.join(this.bareRepoPath, "HEAD"))) !== "exists") return { state: "missing" };
    const bareGit = this.getCachedGit(this.bareRepoPath);
    await this.bareRepo.assertBareRepoOriginMatches(bareGit);

    // The sync's own fetch (`fetchAll`), run in the bare repository because
    // the anchor may be missing; both name the same repository. No auto gc:
    // repacking is not something a dry run should set off.
    await this.getCachedNetworkGit(this.bareRepoPath).fetch(["--all", "--prune", "--no-auto-gc", "--progress"]);

    this.defaultBranch = await this.bareRepo.detectDefaultBranch(bareGit, { readOnly: true });
    this.mainWorktreePath = path.join(this.config.worktreeDir, this.defaultBranch);
    const worktrees = await this.registry.getWorktreesFromBare(bareGit, true);
    const target = path.resolve(this.mainWorktreePath);
    const registered =
      worktrees.find((w) => path.resolve(w.path) === target) ?? worktrees.find((w) => w.branch === this.defaultBranch);
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

  // The default branch's worktree — the directory every remote-facing command
  // runs in (fetch, the branch listings, the tip probes).
  getMainWorktreePath(): string {
    return this.mainWorktreePath;
  }

  // Re-checks the anchor before a sync uses it, and rebuilds it when it was
  // destroyed out-of-band (rm -rf, an unmounted volume). initialize() runs the
  // same heal, but a long-lived process (daemon, TUI, MCP server) initializes
  // once and isInitialized() then stays true forever, so without this every
  // later tick failed at `spawn git ENOENT` — which reads as "git is not
  // installed" — until the process was restarted.
  // Resolves to true when this call rebuilt the worktree.
  async ensureAnchorWorktree(): Promise<boolean> {
    this.assertInitialized();
    const anchorPath = path.resolve(this.mainWorktreePath);
    const probe = await probePathExists(anchorPath);
    if (probe === "exists") return false;
    if (probe === "unknown") {
      // Same rule as every other path decision here: an unverifiable path is
      // not a missing one. Fail naming the directory rather than recreate a
      // worktree that may still be there, or spawn git inside a path that
      // could not even be stat'ed.
      throw new WorktreeError(
        `Cannot determine whether the ${this.defaultBranch} worktree at '${anchorPath}' still exists; refusing to run git there`,
        "ANCHOR_UNVERIFIABLE",
      );
    }

    this.logger.warn(`Default-branch worktree at '${anchorPath}' is missing; recreating it.`);
    const created = await this.ensureMainWorktree(this.getCachedGit(this.bareRepoPath));
    // ensureMainWorktree can settle on another registered checkout of the
    // default branch, so re-point the primary instance the way initialize does.
    this.git = this.getCachedGit(this.mainWorktreePath);
    return created;
  }

  // Re-resolves the default branch from the fetched remote refs and, when the
  // remote renamed it, moves this service over to the new one. Fetches run
  // from the default branch's worktree, so the new default's worktree is
  // created (or an existing one adopted) and this.git re-pointed here, before
  // the caller can prune the old default's worktree. Nothing changes while
  // origin still has the current default. Throws when no default that exists
  // on origin can be resolved: the caller then fails the sync before pruning
  // anything, and the old worktree keeps anchoring fetches until a later
  // sync resolves it.
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
      // The old default's worktree still exists and still anchors fetches;
      // keep pointing at it so the next sync can retry the switch.
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
    // debug: the sync runner announces this as its "Step 1", so at info level
    // every sync printed the same line twice.
    this.logger.debug("Fetching latest data from remote...");
    await this.fetchFromAnchor(["--all", "--prune", "--progress"]);
  }

  async fetchBranch(branchName: string): Promise<void> {
    this.assertInitialized();
    await this.fetchFromAnchor(["origin", branchName, "--prune", "--progress"]);
  }

  // Fetches run in the default branch's worktree. When that directory is gone,
  // spawning git there fails with `spawn git ENOENT`, which reads as "git is
  // not installed" and sends the user looking in the wrong place — so the
  // directory is named instead. ensureAnchorWorktree rebuilds it before every
  // sync attempt; this covers a deletion that lands after that check.
  //
  // Building the client is inside the try: simple-git validates baseDir when
  // a client is constructed, so whether the deletion is reported as a spawn
  // failure (client already cached) or as "Cannot use simple-git on a
  // directory that does not exist" (first use of this path's network client)
  // depends only on timing — both mean the same thing and get the same,
  // probe-confirmed rephrasing.
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

  // Mixed reset: points the index at HEAD without touching working files, so
  // the restored payload's content shows up as ordinary uncommitted changes.
  async resetWorktreeIndex(worktreePath: string): Promise<void> {
    const worktreeGit = this.getCachedGit(worktreePath);
    await worktreeGit.raw(["reset"]);
  }

  // Worktree creation, listing and removal — see WorktreeCreationService and
  // WorktreeRegistryService.

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

  // Branch and ref operations on the bare repository — see BranchRefService.

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

  async remoteBranchExists(branchName: string): Promise<boolean> {
    return this.branchRefs.remoteBranchExists(branchName);
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

  /**
   * @param refScans shares one branch/remote-ref scan between every worktree
   *   probed with it; pass one scope per pass over the worktrees, and none for
   *   a check that must see the refs as they are now.
   */
  async getFullWorktreeStatus(
    worktreePath: string,
    includeDetails = false,
    refScans?: RefScanScope,
  ): Promise<WorktreeStatusResult> {
    const metadata = await this.metadataService.loadMetadataFromPath(this.bareRepoPath, worktreePath);
    return this.statusService.getFullWorktreeStatus(worktreePath, includeDetails, {
      lastSyncCommit: metadata?.lastSyncCommit,
      lastKnownRemoteTip: metadata?.lastKnownRemoteTip,
      refScans,
    });
  }

  /** Map of remote branch name (without "origin/") → tip oid, from the bare repo. */
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

  /**
   * The configured `skipLfs` plus the per-sync override setLfsSkipEnabled
   * installs after an attempt died on an LFS error. Public because clone mode
   * builds its own git clients and has to layer the same setting onto them:
   * reading only `config.skipLfs` there ran the LFS retry with the identical
   * environment, so the attempt announced as "retrying with LFS skipped"
   * smudged exactly like the one that had just failed.
   */
  isLfsSkipEnabled(): boolean {
    return this.config.skipLfs || this.lfsSkipOverride;
  }

  // How many commits HEAD has that origin/<branch> lacks (ahead) and the
  // other way round (behind), from one
  // `rev-list --left-right --count HEAD...refs/remotes/origin/<branch>`
  // (left = ahead, right = behind). This is the whole classification the
  // update phase needs — up to date, behind, ahead, diverged — in one process,
  // where a merge-base pair plus a behind probe used to take three or four.
  // The remote ref is named explicitly — the same ref updateWorktree merges —
  // rather than read from `<branch>@{upstream}`, so a branch with no upstream
  // configured (a restored worktree, one created without a push, the
  // no-tracking fallback) is classified like any other instead of passing as
  // up to date. Unrelated histories count on both sides; only a probe that
  // could not run (the ref is gone, git failed to spawn) throws, so a caller
  // never mistakes "cannot determine" for an answer.
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

  // Fast-forwards the worktree to origin/<branch> and reports whether HEAD
  // actually moved, from a sha comparison around the merge rather than from the
  // runner's earlier behind probe: HEAD can reach the remote tip between the
  // two (a `git pull` in the worktree), and `merge --ff-only` succeeds with
  // nothing to bring in. Sync metadata (lastSyncCommit, lastSyncDate, the
  // syncHistory entry) is only written when HEAD moved, so a no-op leaves no
  // trace of an update that did not happen.
  //
  // The branch is passed in rather than read back with `git branch`: callers
  // reach this from a registration git itself listed, so the extra spawn only
  // re-derived a name they already held — once per updated worktree, on every
  // tick that had anything to update.
  async updateWorktree(worktreePath: string, branch: string): Promise<WorktreeUpdateResult> {
    const worktreeGit = this.getCachedGit(worktreePath, this.isLfsSkipEnabled());

    const before = (await worktreeGit.revparse(["HEAD"])).trim();
    await worktreeGit.merge([`origin/${branch}`, "--ff-only"]);
    const after = (await worktreeGit.revparse(["HEAD"])).trim();
    const updated = after !== before;

    if (updated) {
      try {
        await this.metadataService.updateLastSyncFromPath(
          this.bareRepoPath,
          worktreePath,
          after,
          "updated",
          this.defaultBranch,
        );
      } catch (metadataError) {
        this.logger.warn(`Failed to update metadata for worktree: ${String(metadataError)}`);
      }
    }

    return { updated, before, after };
  }

  // The one place a local ref's relationship to its remote counterpart is
  // derived, so the two callers cannot drift apart on what 'fast-forwardable'
  // means. `localRef` is the local side of the comparison: a sync tick asks
  // about the checkout it is standing in (HEAD), while clone mode's branch
  // switch asks about a branch it has not switched to yet and names
  // `refs/heads/<branch>` instead.
  //
  // Deliberately not `merge-base --is-ancestor`, which would answer in one
  // spawn rather than three: it reports through its exit code and writes
  // nothing to stderr either way, and simple-git only fails a task whose exit
  // code is non-zero AND whose stderr is non-empty — so 'is an ancestor' and
  // 'is not' both arrive here as an empty string and cannot be told apart.
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
    // simple-git swallows merge-base exit 1 and returns "" — treat empty output as failure too.
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
      // Don't .trim() entries — leading/trailing whitespace is valid in POSIX
      // paths and `core.quotePath=false` only affects high-byte quoting, not
      // whitespace. Strip a trailing CR for Windows line endings only.
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
      // Get the tree SHA for the current HEAD
      const localTree = await worktreeGit.raw(["rev-parse", "HEAD^{tree}"]);
      // Get the tree SHA for the remote branch
      const remoteTree = await worktreeGit.raw(["rev-parse", `origin/${branch}^{tree}`]);

      return localTree.trim() === remoteTree.trim();
    } catch (error) {
      this.logger.error(`Error comparing tree content: ${String(error)}`);
      return false; // Assume trees are different if we can't compare
    }
  }

  // Would checking out `origin/<branch>` write over something git is currently
  // ignoring? Comparing every ignored path against every upstream path is
  // O(ignored x upstream) and runs synchronously with the repo lock held, which
  // is minutes of a blocked event loop on a monorepo. Index the upstream tree
  // once instead, then answer each ignored path in constant time per segment.
  private wouldOverwriteIgnoredPaths(ignoredRaw: string, upstreamRaw: string): boolean {
    const upstreamFiles = new Set<string>();
    // Files plus every ancestor directory: membership then means "upstream has
    // content at this path or somewhere beneath it".
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
      // `--directory` reports collapsed directories with a trailing slash.
      const localPath = entry.endsWith("/") ? entry.slice(0, -1) : entry;
      if (upstreamPaths.has(localPath)) return true;
      // The reverse shadowing case: upstream has a file (or submodule) exactly
      // where this ignored path sits inside a directory.
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

    // `--directory` collapses a wholly-ignored directory to one entry, so a
    // node_modules with 150k files costs one path instead of 150k. Directories
    // that also hold tracked files are still expanded, so nothing is missed.
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

    // Update metadata after reset (use path-based method)
    try {
      const currentCommit = await worktreeGit.revparse(["HEAD"]);
      await this.metadataService.updateLastSyncFromPath(
        this.bareRepoPath,
        worktreePath,
        currentCommit.trim(),
        "updated",
        this.defaultBranch,
      );
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
    return this.metadataService.loadMetadataFromPath(this.bareRepoPath, worktreePath);
  }
}
