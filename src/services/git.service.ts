import * as fs from "fs/promises";
import * as path from "path";

import { DEFAULT_CONFIG, ENV_CONSTANTS, ERROR_MESSAGES, GIT_CONSTANTS, PATH_CONSTANTS } from "../constants";
import { ConfigError, GitOperationError, WorktreeError, WorktreeNotCleanError } from "../errors";
import { probePathExists } from "../utils/file-exists";
import { createGitClient } from "../utils/git-client";
import { isGitLfsInstalled, isLfsSmudgeSkippedByEnv, warnGitLfsMissingOnce } from "../utils/git-lfs-probe";
import { makeGitProgressHandler } from "../utils/git-progress";
import { getDefaultBareRepoDir, normalizeRepoUrlForComparison, redactRepoUrl } from "../utils/git-url";
import { getErrorMessage } from "../utils/lfs-error";
import { quarantineDirectory } from "../utils/quarantine";
import { isUnitTestShortcutEnabled } from "../utils/unit-test-shortcut";
import { parseWorktreeListPorcelain } from "../utils/worktree-list-parser";

import { Logger } from "./logger.service";
import { SparseCheckoutService } from "./sparse-checkout.service";
import { WorktreeMetadataService } from "./worktree-metadata.service";
import { WorktreeStatusService } from "./worktree-status.service";

import type { WorktreeStatusResult } from "./worktree-status.service";
import type { Config } from "../types";
import type { SyncMetadata } from "../types/sync-metadata";
import type { GitProgressEmitter } from "../utils/git-progress";
import type { SimpleGit, SimpleGitOptions } from "simple-git";

export type RemoteRelationship = "up_to_date" | "fast_forward" | "local_ahead" | "diverged" | "indeterminate_shallow";

// What updateWorktree did: `updated` is whether the fast-forward moved HEAD;
// `before` and `after` are HEAD on either side of it (equal for a no-op).
export interface WorktreeUpdateResult {
  updated: boolean;
  before: string;
  after: string;
}

// Commits on either side of HEAD...refs/remotes/origin/<branch>: `ahead` are
// HEAD's own, `behind` are the remote tip's. Both above zero means the two
// histories have diverged.
export interface AheadBehindCounts {
  ahead: number;
  behind: number;
}

// One entry of `git worktree list --porcelain`. `locked` carries git's own
// lock flag: a locked worktree is one the user asked git to protect, and git
// refuses to remove it (even with a single --force) until it is unlocked, so
// callers must treat it as off-limits rather than as a removal that failed.
export interface RegisteredWorktree {
  path: string;
  branch: string;
  isPrunable?: boolean;
  // Optional like isPrunable: every listing sets it, and callers that build a
  // worktree by hand (tests, fixtures) should not have to.
  locked?: boolean;
  /** Reason given to `git worktree lock --reason`; absent when git records none. */
  lockReason?: string;
  /**
   * Set (to true) only for a worktree git lists as detached — one with no
   * branch checked out. `getWorktrees()` filters those out entirely, so only
   * listings that ask for detached entries ever carry it.
   */
  detached?: boolean;
}

// What one addWorktree call did. `created` carries the new worktree's HEAD —
// the commit callers compare against origin/<branch>. `already_registered`
// means the path was a registered worktree before the call and nothing was
// created: either one a concurrent operation registered first, or a
// detached-HEAD checkout someone left there, which no sync of ours owns.
export type AddWorktreeResult =
  { status: "created"; head: string } | { status: "already_registered"; detached: boolean };

export interface DefaultBranchRefresh {
  previous: string;
  defaultBranch: string;
  // The default branch's worktree — where fetches run from now.
  mainWorktreePath: string;
  // Whether this refresh created that worktree (rather than keeping or
  // adopting an existing one).
  created: boolean;
}

// Branch names per `git branch -D` invocation when dropping a fresh bare
// clone's refs/heads/* copies. One call per batch keeps a repository with
// thousands of branches to a handful of packed-refs rewrites instead of one
// per ref, while staying far below any platform's argument-length limit.
const BRANCH_DELETE_BATCH_SIZE = 200;

// How many of a worktree's LFS files are read back after a checkout. The check
// answers "did the smudge filter run here at all", which a sample settles just
// as well as reading every file.
const LFS_VERIFICATION_SAMPLE_SIZE = 5;

// The `.gitattributes` entry that hands a path to git-lfs. A repository whose
// HEAD declares none never had LFS content, so nothing about LFS is worth
// running (or warning about) for it.
const LFS_FILTER_ATTRIBUTE = "filter=lfs";

// How many tree oids keep their "declares an LFS filter" verdict. The entries
// are content-addressed and can never go stale, so this only bounds memory in a
// daemon that runs for weeks.
const LFS_ATTRIBUTE_CACHE_LIMIT = 256;

// Full-ref prefix of origin's remote-tracking branches. Every inventory
// listing reads %(refname) and strips this literal prefix, never
// %(refname:short): git's short form is ambiguity-dependent and silently
// renames refs. It shortens refs/remotes/origin/feature/HEAD to
// "origin/feature" (a branch that does not exist) and prints
// "remotes/origin/x" whenever a local branch literally named "origin/x"
// exists — either way the real branch leaves the inventory and its worktree
// then reads as stale and is pruned.
const REMOTE_REF_PREFIX = `${GIT_CONSTANTS.REFS.REMOTES}/`;

// The one ref under that prefix that is not a branch: the symref
// `git remote set-head` writes. It is excluded by its full name only —
// "feature/HEAD" is a legal branch name, so an endsWith("/HEAD") test would
// drop a real branch (and prune its worktree) along with the symref.
const ORIGIN_HEAD_REF = `${REMOTE_REF_PREFIX}HEAD`;
const ORIGIN_HEAD_SHORT_REF = `${GIT_CONSTANTS.REMOTE_PREFIX}HEAD`;

export type GitServiceOptions = Pick<
  Config,
  | "repoUrl"
  | "worktreeDir"
  | "bareRepoDir"
  | "skipLfs"
  | "debug"
  | "sparseCheckout"
  | "fetchTimeoutMs"
  | "cloneTimeoutMs"
>;

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
  // Tree oid -> whether that tree's .gitattributes declare an LFS filter.
  private lfsAttributeCache = new Map<string, boolean>();
  private gitInstances = new Map<string, SimpleGit>();

  constructor(
    private config: GitServiceOptions,
    logger?: Logger,
    private progressEmitter?: GitProgressEmitter,
  ) {
    this.logger = logger ?? Logger.createDefault(undefined, config.debug);
    this.bareRepoPath = this.config.bareRepoDir || getDefaultBareRepoDir(this.config.repoUrl);
    this.mainWorktreePath = path.join(this.config.worktreeDir, GIT_CONSTANTS.DEFAULT_BRANCH); // Temporary, will be updated
    this.metadataService = new WorktreeMetadataService(this.logger);
    this.statusService = new WorktreeStatusService({ skipLfs: this.config.skipLfs }, this.logger);
    this.sparseCheckoutService = new SparseCheckoutService(this.logger);
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
    const key = `${path.resolve(dirPath)}::${useLfsSkip ? "1" : "0"}::${kind}`;
    let git = this.gitInstances.get(key);
    if (!git) {
      git = createGitClient(
        dirPath,
        useLfsSkip ? { [ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE]: "1" } : {},
        this.buildSimpleGitOptions(kind === "network" ? this.getFetchTimeoutMs() : 0),
      );
      this.gitInstances.set(key, git);
    }
    return git;
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
      progress: makeGitProgressHandler(this.logger, (event) => this.progressEmitter?.(event)),
    };
    if (blockMs > 0) options.timeout = { block: blockMs };
    return options;
  }

  updateLogger(logger: Logger): void {
    this.logger = logger;
    this.sparseCheckoutService.updateLogger(logger);
  }

  async initialize(): Promise<SimpleGit> {
    const { repoUrl } = this.config;

    // Check if bare repo already exists
    let bareRepoExists: boolean;
    try {
      await fs.access(path.join(this.bareRepoPath, "HEAD"));
      bareRepoExists = true;
    } catch {
      bareRepoExists = false;
    }

    if (bareRepoExists) {
      await this.assertBareRepoOriginMatches(this.getCachedGit(this.bareRepoPath));
    } else {
      // Clone as bare repository
      this.logger.info(`Cloning from "${redactRepoUrl(repoUrl)}" as bare repository into "${this.bareRepoPath}"...`);
      await fs.mkdir(path.dirname(this.bareRepoPath), { recursive: true });
      const cloneGit = createGitClient(
        undefined,
        this.isLfsSkipEnabled() ? { [ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE]: "1" } : {},
        this.buildSimpleGitOptions(this.getCloneTimeoutMs()),
      );
      await cloneGit.clone(repoUrl, this.bareRepoPath, ["--bare", "--progress"]);
      this.logger.info("✅ Clone successful.");
      await this.dropClonedBranchCopies(this.getCachedGit(this.bareRepoPath));
    }

    // Configure bare repository for worktrees
    const bareGit = this.getCachedGit(this.bareRepoPath);

    // Check if fetch config already exists
    try {
      const existingConfig = await bareGit.raw(["config", "--get-all", "remote.origin.fetch"]);
      const targetConfig = "+refs/heads/*:refs/remotes/origin/*";

      if (!existingConfig.includes(targetConfig)) {
        await bareGit.addConfig("remote.origin.fetch", targetConfig);
      }
    } catch {
      // Config doesn't exist, add it
      await bareGit.addConfig("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    }

    // Always fetch to ensure remote refs are up-to-date
    // This is needed for branch creation UI even when repo already exists
    this.logger.info("Fetching remote branches...");
    await this.getCachedNetworkGit(this.bareRepoPath).fetch(["--all", "--progress"]);

    // Detect the default branch (works from local refs even without fetch)
    this.defaultBranch = await this.detectDefaultBranch(bareGit);
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
      const worktrees = await this.getWorktreesFromBare(bareGit, true);
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
        !(await this.isRegisteredWorktree(bareGit, this.mainWorktreePath))
      ) {
        throw error;
      }
      this.logger.info(
        `${this.defaultBranch} worktree at '${this.mainWorktreePath}' was registered concurrently; reusing it.`,
      );
    }

    if (!(await this.isRegisteredWorktree(bareGit, this.mainWorktreePath))) {
      throw new WorktreeError(
        `${this.defaultBranch} worktree at '${path.resolve(this.mainWorktreePath)}' is not registered with the bare repository at '${path.resolve(this.bareRepoPath)}' after creation`,
        "NOT_REGISTERED",
      );
    }
    return created;
  }

  // An existing bare repo is found by path alone, and the default bareRepoDir
  // is `.bare/<repo-name>` — the same directory for old-org/app and
  // new-org/app. So before anything is fetched from it, its origin must be
  // the configured repoUrl; otherwise a changed repoUrl would keep syncing
  // the remote the bare repo was cloned from, and nothing in the log would
  // say so. Mirrors clone mode's origin check: URLs compare normalized
  // (scheme/host case, trailing slash, forge `.git`) so equivalent spellings
  // don't false-positive, and are shown redacted. A bare repo whose origin
  // cannot be read is not a mismatch — the fetch that follows reports it.
  private async assertBareRepoOriginMatches(bareGit: SimpleGit): Promise<void> {
    const bareRepoPath = path.resolve(this.bareRepoPath);

    let originUrl: string;
    try {
      originUrl = (await bareGit.raw(["remote", "get-url", "origin"])).trim();
    } catch {
      this.logger.warn(`Could not read 'origin' remote URL from existing bare repository at '${bareRepoPath}'.`);
      return;
    }

    if (!originUrl || normalizeRepoUrlForComparison(originUrl) === normalizeRepoUrlForComparison(this.config.repoUrl)) {
      return;
    }

    const actual = redactRepoUrl(originUrl);
    const expected = redactRepoUrl(this.config.repoUrl);
    throw new ConfigError(
      `Existing bare repository at '${bareRepoPath}' has origin '${actual}', expected '${expected}'. ` +
        `Update the remote (git -C "${bareRepoPath}" remote set-url origin "${expected}") or point bareRepoDir at a fresh directory.`,
      "ORIGIN_MISMATCH",
    );
  }

  // `git clone --bare` copies every remote branch into refs/heads/*, and the
  // fetch refspec only ever updates refs/remotes/origin/*, so those copies
  // stay frozen at clone time. A worktree added months later for such a
  // branch would check out that frozen tip: addWorktree fast-forwards a copy
  // that is merely behind to origin's tip, but a copy whose commits were
  // rebased away on the remote is indistinguishable from never-pushed work
  // and is kept.
  // Drop the copies while they are provably copies — right after the clone,
  // before any worktree exists. The branch HEAD points at stays (the
  // default-branch worktree is created from it). An existing bare repository
  // is never touched here: its refs/heads/* may carry real local-only commits
  // from a worktree that was removed. Best-effort — a leftover copy is a
  // stale-checkout risk that addWorktree mitigates, not a broken repository.
  private async dropClonedBranchCopies(bareGit: SimpleGit): Promise<void> {
    try {
      // `-q` is safe here even though simple-git resolves its silent exit 1:
      // the empty string it yields for a HEAD that is not a symref means "no
      // branch to protect", which is what a detached HEAD actually is.
      const headRef = (await bareGit.raw(["symbolic-ref", "-q", "HEAD"])).trim();
      const branches = (await bareGit.raw(["for-each-ref", "--format=%(refname)", GIT_CONSTANTS.REFS.HEADS]))
        .split("\n")
        .map((line) => line.trim())
        .filter((ref) => ref.startsWith(GIT_CONSTANTS.REFS.HEADS) && ref !== headRef)
        .map((ref) => ref.slice(GIT_CONSTANTS.REFS.HEADS.length));
      if (branches.length === 0) return;

      for (let start = 0; start < branches.length; start += BRANCH_DELETE_BATCH_SIZE) {
        await bareGit.raw(["branch", "-D", ...branches.slice(start, start + BRANCH_DELETE_BATCH_SIZE)]);
      }
      this.logger.info(
        `Removed ${branches.length} clone-time local branch ${branches.length === 1 ? "copy" : "copies"}; worktrees are created from origin/* instead.`,
      );
    } catch (error) {
      this.logger.warn(`Could not remove clone-time local branch copies: ${getErrorMessage(error)}`);
    }
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

    const detected = await this.detectDefaultBranch(bareGit);
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
    const git = createGitClient(undefined, {}, this.buildSimpleGitOptions(this.getFetchTimeoutMs()));

    try {
      const out = await git.raw(["ls-remote", "--symref", repoUrl, "HEAD"]);
      const match = out.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m);
      if (match && match[1]) {
        return match[1];
      }
    } catch {
      /* fall through to probe candidates */
    }

    // symref HEAD was unavailable/unparsed: probe common branch names, but only
    // auto-pick when the choice is unambiguous. Guessing by fixed priority when
    // several exist can silently track the wrong branch (e.g. 'main' when the
    // remote's real default is 'master').
    const existing: string[] = [];
    for (const candidate of GIT_CONSTANTS.COMMON_DEFAULT_BRANCHES) {
      try {
        const out = await git.raw(["ls-remote", "--exit-code", repoUrl, `refs/heads/${candidate}`]);
        if (out.trim().length > 0) {
          existing.push(candidate);
        }
      } catch {
        /* candidate missing — try next */
      }
    }

    if (existing.length === 1) {
      this.logger.warn(
        `Could not read symref HEAD for '${redactRepoUrl(repoUrl)}'; using the only common branch found ('${existing[0]}') as the default.`,
      );
      return existing[0];
    }

    if (existing.length > 1) {
      throw new Error(
        `Unable to detect default branch for '${redactRepoUrl(repoUrl)}': symref HEAD is unavailable and multiple common branches exist (${existing.join(", ")}). ` +
          `Set 'branch' explicitly in the repository config.`,
      );
    }

    throw new Error(
      `Unable to detect default branch for '${redactRepoUrl(repoUrl)}'. ` +
        `Set 'branch' explicitly in the repository config or ensure the remote is reachable.`,
    );
  }

  async verifyLfs(worktreePath: string, label: string): Promise<void> {
    await this.verifyLfsFilesDownloaded(worktreePath, label);
  }

  async fetchAll(): Promise<void> {
    this.assertInitialized();
    this.logger.info("Fetching latest data from remote...");
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
    const git = this.getGit();
    const branches = await git.branch(["-r", "--no-color"]);
    return GitService.remoteBranchNames(branches.all);
  }

  // Remote branch names (without "origin/") from a `branch -r` listing, which
  // prints %(refname:lstrip=2) — always "origin/<name>" verbatim, never a
  // disambiguated short name.
  // Filter on the full ref BEFORE stripping the prefix: a remote branch
  // literally named "origin" lists as "origin/origin" and is a real branch —
  // filtering the stripped name would silently drop it (and its worktree
  // would then read as stale and be pruned). Only the origin/HEAD symref is
  // excluded, by its exact name: "feature/HEAD" is a legal branch name, so an
  // endsWith("/HEAD") test would drop it too. git renders the symref as an
  // "origin/HEAD -> origin/main" arrow line; a refname can never contain a
  // space, so such a line is dropped whether or not the parser split it.
  // Callers must pass --no-color: under color.ui=always git wraps every name
  // in escape codes, the prefix test then fails for all of them, and an empty
  // inventory turns every worktree into a prune candidate.
  private static remoteBranchNames(refs: string[]): string[] {
    return refs
      .filter((b) => b.startsWith(GIT_CONSTANTS.REMOTE_PREFIX) && b !== ORIGIN_HEAD_SHORT_REF && !b.includes(" "))
      .map((b) => b.slice(GIT_CONSTANTS.REMOTE_PREFIX.length))
      .filter((b) => b.length > 0);
  }

  // Branch name for one full remote-tracking ref, or null when the ref is not
  // one of origin's branches (a foreign prefix, the origin/HEAD symref, or the
  // prefix with nothing after it).
  private static remoteBranchFromRef(ref: string): string | null {
    if (!ref.startsWith(REMOTE_REF_PREFIX) || ref === ORIGIN_HEAD_REF) return null;
    const branch = ref.slice(REMOTE_REF_PREFIX.length);
    return branch.length > 0 ? branch : null;
  }

  async getRemoteBranchesWithActivity(): Promise<{ branch: string; lastActivity: Date }[]> {
    const git = this.getGit();
    // NUL delimiter: "|" is a legal branch-name character, so a branch like
    // "feature|wip" would corrupt a "|"-delimited line and be silently dropped
    // from the inventory (and its worktree then pruned as stale). A refname can
    // never contain NUL or newline.
    const result = await git.raw([
      "for-each-ref",
      "--format=%(refname)%00%(committerdate:iso8601)",
      GIT_CONSTANTS.REFS.REMOTES,
    ]);

    const branches: { branch: string; lastActivity: Date }[] = [];
    const lines = result
      .trim()
      .split("\n")
      .filter((line) => line);

    for (const line of lines) {
      const [ref, dateStr] = line.split("\0", 2);
      if (!ref || !dateStr) continue;
      // Same rule as getRemoteBranches: strip the literal prefix off the full
      // refname, never filter the stripped name (a branch literally named
      // "origin" is real, and so is one named "feature/HEAD").
      const branch = GitService.remoteBranchFromRef(ref);
      if (branch === null) continue;
      const lastActivity = new Date(dateStr);
      // Skip if the date is invalid
      if (!isNaN(lastActivity.getTime())) {
        branches.push({ branch, lastActivity });
      }
    }

    return branches;
  }

  // Verification only means something when the checkout was meant to
  // materialize LFS content. `skipLfs` (configured, or the per-sync override
  // after an LFS checkout failure) and a GIT_LFS_SKIP_SMUDGE inherited from the
  // shell or the CI job both make pointer files on disk the expected outcome —
  // not a fault to sample for, and not something to warn about.
  private isLfsVerificationDisabled(): boolean {
    return this.isLfsSkipEnabled() || isLfsSmudgeSkippedByEnv();
  }

  // One look at what `git worktree add` (or, in clone mode, `git clone`) just
  // checked out: `git checkout` — git-lfs delayed checkout and the
  // post-checkout hook included — completes before the command returns, so
  // nothing rewrites those files afterwards and the first read is already the
  // final answer. Earlier releases re-read the samples once a second for up to
  // 30 s per created worktree, serialized across branches, which turned a first
  // sync of 100 branches whose LFS content stayed pointers (an exported
  // GIT_LFS_SKIP_SMUDGE, an `lfs.fetchexclude` pattern, an LFS server outage)
  // into ~50 minutes of sleeping and 100 warnings.
  private async verifyLfsFilesDownloaded(worktreePath: string, branchName: string): Promise<void> {
    if (this.isLfsVerificationDisabled()) return;

    const worktreeGit = this.config.sparseCheckout
      ? // `lfs ls-files` reads the index and .gitattributes — a local command,
        // so no inactivity kill, same as the cached client used otherwise.
        createGitClient(worktreePath, { [ENV_CONSTANTS.GIT_ATTR_SOURCE]: "HEAD" }, this.buildSimpleGitOptions(0))
      : this.getCachedGit(worktreePath);

    try {
      if (!(await this.headDeclaresLfsFilter(worktreeGit))) return;

      // Only repositories that actually use LFS get here, so a machine without
      // git-lfs is worth one warning per process — never one per worktree, and
      // never at all for the repositories that have no LFS content.
      if (!(await isGitLfsInstalled(() => worktreeGit.raw(["lfs", "version"])))) {
        warnGitLfsMissingOnce((message) => this.logger.warn(message));
        return;
      }

      const lfsFiles = await this.listCheckedOutLfsFiles(worktreeGit, worktreePath);
      if (lfsFiles.length === 0) return;

      if (this.config.debug) {
        this.logger.info(`  - Verifying ${lfsFiles.length} LFS files are downloaded...`);
      }

      const samples = GitService.sampleFiles(lfsFiles, LFS_VERIFICATION_SAMPLE_SIZE);
      const pointers = await GitService.findPointerFiles(worktreePath, samples);

      if (pointers.length === 0) {
        if (this.config.debug) {
          this.logger.info(`  - ✅ LFS files verified (${samples.length} samples checked)`);
        }
        return;
      }

      this.logger.warn(
        `  - ⚠️ LFS content was not downloaded into '${worktreePath}': ${pointers.join(", ")} still hold git-lfs ` +
          `pointer files. Check that git-lfs can fetch this repository's objects (credentials, \`lfs.fetchexclude\`, ` +
          `a GIT_LFS_SKIP_SMUDGE exported in this environment), or set 'skipLfs: true' for it to keep pointers on purpose.`,
      );
    } catch (error) {
      this.logger.warn(`  - ⚠️ Warning: Could not verify LFS files for '${branchName}': ${String(error)}`);
    }
  }

  // Whether HEAD declares an LFS filter in any .gitattributes. A repository
  // that never used LFS answers no, and then no `git lfs ls-files` walks its
  // whole index for every worktree created.
  //
  // Cached by the tree oid HEAD points at: a tree's content is its name, so an
  // entry is right forever — no per-sync invalidation to get wrong in a daemon
  // that runs for weeks — and branches sharing a tree share the answer.
  private async headDeclaresLfsFilter(git: SimpleGit): Promise<boolean> {
    let treeOid: string;
    try {
      treeOid = (await git.revparse(["HEAD^{tree}"])).trim();
    } catch {
      // No resolvable HEAD (an unborn branch, a checkout that never landed)
      // means there are no checked-out files to verify.
      return false;
    }

    const cached = this.lfsAttributeCache.get(treeOid);
    if (cached !== undefined) return cached;

    const declaresFilter = await GitService.treeDeclaresLfsFilter(git, treeOid);
    if (this.lfsAttributeCache.size >= LFS_ATTRIBUTE_CACHE_LIMIT) {
      const oldest = this.lfsAttributeCache.keys().next();
      if (!oldest.done) this.lfsAttributeCache.delete(oldest.value);
    }
    this.lfsAttributeCache.set(treeOid, declaresFilter);
    return declaresFilter;
  }

  // Greps the tree rather than the working copy: with sparse checkout most
  // .gitattributes files are not on disk, and the pathspec keeps the search to
  // those files wherever in the tree they sit.
  private static async treeDeclaresLfsFilter(git: SimpleGit, treeOid: string): Promise<boolean> {
    try {
      const matches = await git.raw([
        "grep",
        "--name-only",
        "-I",
        "--fixed-strings",
        "-e",
        LFS_FILTER_ATTRIBUTE,
        treeOid,
        "--",
        "*.gitattributes",
      ]);
      return matches.trim().length > 0;
    } catch (error) {
      // Exit 1 is `git grep`'s "nothing matched" — a definite no. Any other
      // failure leaves the question open, and verifying is the safe answer.
      return !getErrorMessage(error).includes(GIT_CONSTANTS.GIT_NO_MATCH_EXIT);
    }
  }

  // The LFS files that are actually on disk. With sparse checkout,
  // GIT_ATTR_SOURCE=HEAD lists every LFS file HEAD's .gitattributes declare,
  // including ones outside the cone that were never written — sampling those
  // would report a checkout failure that never happened.
  private async listCheckedOutLfsFiles(git: SimpleGit, worktreePath: string): Promise<string[]> {
    const listed = (await git.raw(["lfs", "ls-files", "--name-only"]))
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);

    if (!this.config.sparseCheckout || listed.length === 0) return listed;

    const existence = await Promise.all(
      listed.map(async (f) => {
        try {
          await fs.access(path.join(worktreePath, f));
          return f;
        } catch {
          return null;
        }
      }),
    );
    return existence.filter((f): f is string => f !== null);
  }

  // Up to `count` distinct files, picked with a partial Fisher-Yates shuffle so
  // a repeated sync does not keep checking the same ones.
  private static sampleFiles(files: string[], count: number): string[] {
    const sampleSize = Math.min(count, files.length);
    const shuffled = [...files];
    for (let i = 0; i < sampleSize; i++) {
      const randomIndex = i + Math.floor(Math.random() * (shuffled.length - i));
      [shuffled[i], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[i]];
    }
    return shuffled.slice(0, sampleSize);
  }

  // The sampled files that still hold a pointer, plus any that cannot be read
  // at all: both mean the checkout did not materialize the content.
  private static async findPointerFiles(worktreePath: string, files: string[]): Promise<string[]> {
    const pointers: string[] = [];
    for (const file of files) {
      if (await GitService.holdsLfsPointer(path.join(worktreePath, file))) {
        pointers.push(file);
      }
    }
    return pointers;
  }

  // Reads the first bytes only: a pointer is a small text blob starting with
  // the git-lfs spec header, while the real content can be gigabytes.
  private static async holdsLfsPointer(filePath: string): Promise<boolean> {
    try {
      const handle = await fs.open(filePath, "r");
      try {
        const buffer = Buffer.alloc(200);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString("utf8").startsWith(GIT_CONSTANTS.LFS_HEADER);
      } finally {
        await handle.close();
      }
    } catch {
      return true;
    }
  }

  async checkoutHead(worktreePath: string): Promise<void> {
    const git = this.getCachedGit(worktreePath, this.isLfsSkipEnabled());
    await git.raw(["checkout", "HEAD"]);
  }

  private async applySparseAndCheckout(absoluteWorktreePath: string): Promise<void> {
    if (!this.config.sparseCheckout) return;
    await this.sparseCheckoutService.applyToWorktree(absoluteWorktreePath, this.config.sparseCheckout);
    const worktreeGit = this.getCachedGit(absoluteWorktreePath, this.isLfsSkipEnabled());
    await worktreeGit.raw(["checkout", "HEAD"]);
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
    } catch (rollbackError) {
      worktreeRemoved = false;
      const ctx = failureContext ? ` after ${failureContext}` : "";
      this.logger.warn(
        `  - Rollback failed for '${branchName}' at '${absoluteWorktreePath}'${ctx}: ${getErrorMessage(rollbackError)}`,
      );
    }
    if (createdNewBranch) {
      try {
        await bareGit.raw(["branch", "-D", branchName]);
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
      const worktreeGit = this.getCachedGit(worktreePath, this.isLfsSkipEnabled());
      const currentCommit = (await worktreeGit.revparse(["HEAD"])).trim();
      // refs/heads/<default>, not the bare name: a tag sharing the default
      // branch's name resolves first and would record the tag's commit as the
      // worktree's parent.
      const parentCommit = await bareGit.revparse([`${GIT_CONSTANTS.REFS.HEADS}${this.defaultBranch}`]);

      await this.metadataService.createInitialMetadataFromPath(
        this.bareRepoPath,
        worktreePath,
        currentCommit,
        `origin/${branchName}`,
        this.defaultBranch,
        parentCommit.trim(),
      );
      return currentCommit;
    } catch (metadataError) {
      this.logger.error(`  - ❌ Failed to create metadata for '${branchName}': ${String(metadataError)}`);
      throw new Error(`Metadata creation failed for ${branchName}. This worktree cannot be auto-managed.`);
    }
  }

  // Resolves to what the call did: the HEAD commit of the worktree it created,
  // or `already_registered` when the path already was a registered worktree
  // (one a concurrent operation registered first, or a detached-HEAD checkout
  // someone left there) and nothing was created. Callers that count creations
  // must read `status` rather than assume a create happened.
  async addWorktree(branchName: string, worktreePath: string): Promise<AddWorktreeResult> {
    const bareGit = this.getCachedGit(this.bareRepoPath, this.isLfsSkipEnabled());
    // Use absolute path for worktree add to avoid relative path issues
    const absoluteWorktreePath = path.resolve(worktreePath);
    // Ensure parent directory exists for nested branch paths
    await fs.mkdir(path.dirname(absoluteWorktreePath), { recursive: true });

    // Check if directory already exists (could be from a failed previous attempt)
    try {
      await fs.access(absoluteWorktreePath);
      // Directory exists - check if it's already a valid worktree
      const worktrees = await this.getWorktreesFromBare(bareGit, true);
      const registered = worktrees.find((w) => path.resolve(w.path) === absoluteWorktreePath);

      if (registered) {
        this.logger.info(`  - Worktree for '${branchName}' already exists at '${absoluteWorktreePath}'`);
        return { status: "already_registered", detached: registered.detached === true };
      } else {
        // Directory exists but is not a valid worktree - clean it up
        this.logger.info(`  - Cleaning up orphaned directory at '${absoluteWorktreePath}'`);
        await this.clearStaleWorktreeDirectory(absoluteWorktreePath);
      }
    } catch (error) {
      if (error instanceof GitOperationError || error instanceof WorktreeError) {
        throw error;
      }
      // Directory doesn't exist, which is expected - continue with creation
    }

    let createdNewBranch: boolean;
    try {
      const { local: localBranchExists, remote: remoteBranchExists } = await this.branchExists(branchName);

      createdNewBranch = await this.runWorktreeAddByMatrix(
        bareGit,
        branchName,
        absoluteWorktreePath,
        localBranchExists,
        remoteBranchExists,
      );

      if (localBranchExists && !remoteBranchExists) {
        this.logger.info(`  - Created worktree for '${branchName}' (no remote yet — push to set upstream)`);
      } else {
        this.logger.info(`  - Created worktree for '${branchName}' with tracking to origin/${branchName}`);
      }

      await this.verifyLfsFilesDownloaded(absoluteWorktreePath, branchName);

      try {
        const head = await this.createWorktreeMetadata(bareGit, absoluteWorktreePath, branchName);
        return { status: "created", head };
      } catch (metadataError) {
        this.logger.warn(`  - Metadata creation failed for '${branchName}', removing worktree to prevent orphan`);
        await this.rollbackPartialWorktree(bareGit, absoluteWorktreePath, branchName, createdNewBranch);
        throw new Error(`Metadata creation failed for '${branchName}': ${getErrorMessage(metadataError)}`);
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      // Upstream setup failures are already rolled back inside runWorktreeAddByMatrix.
      // Don't enter the tracking-error fallback (which would silently accept a partial worktree).
      if ((error as { isUpstreamSetupFailure?: boolean })?.isUpstreamSetupFailure) {
        throw error;
      }

      // Re-throw metadata creation errors - these are fatal and should not fall back
      if (errorMessage.includes("Metadata creation failed")) {
        throw error;
      }

      // Check if this is an "already registered" error
      if (errorMessage.includes("already registered worktree")) {
        // Check if worktree was actually created by a concurrent operation
        const worktrees = await this.getWorktreesFromBare(bareGit, true);
        const existingWorktree = worktrees.find((w) => path.resolve(w.path) === absoluteWorktreePath);

        if (existingWorktree && !existingWorktree.isPrunable) {
          this.logger.info(`  - Worktree for '${branchName}' was created by concurrent operation`);
          return { status: "already_registered", detached: existingWorktree.detached === true };
        }

        this.logger.warn(`  - Worktree already registered but missing. Removing that registration and retrying...`);
        try {
          await bareGit.raw(["worktree", "remove", "--force", absoluteWorktreePath]);
        } catch (removalError) {
          this.logger.warn(
            `  - Failed to remove stale registration for '${absoluteWorktreePath}': ${getErrorMessage(removalError)}. Continuing with directory cleanup and retry.`,
          );
        }
        await this.clearStaleWorktreeDirectory(absoluteWorktreePath);
        let retryCreatedNewBranch: boolean;
        try {
          const { local: localBranchExists, remote: remoteBranchExists } = await this.branchExists(branchName);
          retryCreatedNewBranch = await this.runWorktreeAddByMatrix(
            bareGit,
            branchName,
            absoluteWorktreePath,
            localBranchExists,
            remoteBranchExists,
          );
          this.logger.info(`  - Created worktree for '${branchName}' on retry`);

          await this.verifyLfsFilesDownloaded(absoluteWorktreePath, branchName);

          try {
            const head = await this.createWorktreeMetadata(bareGit, absoluteWorktreePath, branchName);
            return { status: "created", head };
          } catch (metadataError) {
            this.logger.warn(`  - Metadata creation failed for '${branchName}', removing worktree to prevent orphan`);
            await this.rollbackPartialWorktree(bareGit, absoluteWorktreePath, branchName, retryCreatedNewBranch);
            throw new Error(`Metadata creation failed for '${branchName}': ${getErrorMessage(metadataError)}`);
          }
        } catch (retryError) {
          this.logger.error(`  - Failed to create worktree on retry: ${String(retryError)}`);
          throw retryError;
        }
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

      // Check again if directory exists before fallback attempt
      try {
        await fs.access(absoluteWorktreePath);
        // Directory exists - check if it's already a valid worktree
        const worktrees = await this.getWorktreesFromBare(bareGit, true);
        const registered = worktrees.find((w) => path.resolve(w.path) === absoluteWorktreePath);

        if (registered) {
          this.logger.info(`  - Worktree for '${branchName}' already exists at '${absoluteWorktreePath}'`);
          return { status: "already_registered", detached: registered.detached === true };
        } else {
          // Directory exists but is not a valid worktree - clean it up
          this.logger.info(`  - Cleaning up orphaned directory at '${absoluteWorktreePath}' before fallback attempt`);
          await this.clearStaleWorktreeDirectory(absoluteWorktreePath);
        }
      } catch (error) {
        if (error instanceof GitOperationError || error instanceof WorktreeError) {
          throw error;
        }
        // Directory doesn't exist, which is expected - continue with fallback
      }

      try {
        const useNoCheckout = !!this.config.sparseCheckout;
        const fallbackArgs = useNoCheckout
          ? ["worktree", "add", "--no-checkout", absoluteWorktreePath, branchName]
          : ["worktree", "add", absoluteWorktreePath, branchName];
        await bareGit.raw(fallbackArgs);
        await this.runSparseStepWithRollback(bareGit, absoluteWorktreePath, branchName, false);
        // The plain add set no upstream; give it one when origin/<branch> exists.
        const tracking = await this.trackRemoteBranchIfExists(branchName, absoluteWorktreePath);
        this.logger.info(`  - Created worktree for '${branchName}'${tracking ? "" : " (without tracking)"}`);

        await this.verifyLfsFilesDownloaded(absoluteWorktreePath, branchName);

        try {
          const head = await this.createWorktreeMetadata(bareGit, absoluteWorktreePath, branchName);
          return { status: "created", head };
        } catch (metadataError) {
          this.logger.warn(`  - Metadata creation failed for '${branchName}', removing worktree to prevent orphan`);
          await this.rollbackPartialWorktree(bareGit, absoluteWorktreePath, branchName, false);
          throw new Error(`Metadata creation failed for '${branchName}': ${getErrorMessage(metadataError)}`);
        }
      } catch (fallbackError) {
        const fallbackErrorMessage = getErrorMessage(fallbackError);

        // If fallback also fails with "already registered", check if created by concurrent op
        if (fallbackErrorMessage.includes("already registered worktree")) {
          const worktrees = await this.getWorktreesFromBare(bareGit, true);
          const existingWorktree = worktrees.find((w) => path.resolve(w.path) === absoluteWorktreePath);

          if (existingWorktree && !existingWorktree.isPrunable) {
            this.logger.info(`  - Worktree for '${branchName}' was created by concurrent operation during fallback`);
            return { status: "already_registered", detached: existingWorktree.detached === true };
          }
        }

        // If still failing, this is a real error
        throw fallbackError;
      }
    }
  }

  private async runWorktreeAddByMatrix(
    bareGit: SimpleGit,
    branchName: string,
    absoluteWorktreePath: string,
    localExists: boolean,
    remoteExists: boolean,
  ): Promise<boolean> {
    const useNoCheckout = !!this.config.sparseCheckout;
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
        const worktreeGit = this.getCachedGit(absoluteWorktreePath, this.isLfsSkipEnabled());
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
        if (!getErrorMessage(error).includes("already registered worktree")) {
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
    const worktreeGit = this.getCachedGit(absoluteWorktreePath, this.isLfsSkipEnabled());
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
      if (!(await this.refExists(bareGit, `${GIT_CONSTANTS.REFS.HEADS}${branchName}`))) return;
      // The branch git just created sits at origin/<branch>. Anything ahead of
      // the remote was written by someone else between the probe and the add,
      // and a bare repo keeps no reflog to recover it from.
      if ((await this.countLocalOnlyCommits(bareGit, branchName)) !== 0) {
        this.logger.warn(
          `  - Left the local branch '${branchName}' in place: it carries commits that are not on origin/${branchName}`,
        );
        return;
      }
      await bareGit.raw(["branch", "-D", branchName]);
      this.logger.info(`  - Removed the local branch '${branchName}' left behind by the failed worktree add`);
    } catch (error) {
      this.logger.warn(
        `  - Could not remove the local branch '${branchName}' left behind by the failed worktree add: ${getErrorMessage(error)}`,
      );
    }
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
  ): Promise<Error> {
    const { worktreeRemoved } = await this.rollbackPartialWorktree(
      bareGit,
      absoluteWorktreePath,
      branchName,
      createdNewBranch,
      "upstream setup error",
    );
    const suffix = worktreeRemoved ? "" : " (rollback failed; partial worktree may remain)";
    const wrapped = new Error(`Failed to set upstream for '${branchName}': ${getErrorMessage(error)}${suffix}`);
    (wrapped as Error & { isUpstreamSetupFailure?: boolean }).isUpstreamSetupFailure = true;
    return wrapped;
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
    const bareGit = this.getCachedGit(this.bareRepoPath);

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
      if (GitService.isRemovalRefusal(message, options?.force ?? false)) {
        throw new WorktreeNotCleanError(worktreePath, [`git refused removal: ${message}`]);
      }
      throw error;
    }
    this.logger.info(`  - ✅ Safely removed stale worktree at '${worktreePath}'.`);

    // Clean up metadata using the worktree path
    try {
      await this.metadataService.deleteMetadataFromPath(this.bareRepoPath, worktreePath);
    } catch (metadataError) {
      this.logger.warn(`Failed to delete metadata for worktree: ${String(metadataError)}`);
    }
  }

  async updateRef(refName: string, sha: string): Promise<void> {
    const bareGit = this.getCachedGit(this.bareRepoPath);
    await bareGit.raw(["update-ref", refName, sha]);
  }

  async deleteRef(refName: string): Promise<void> {
    const bareGit = this.getCachedGit(this.bareRepoPath);
    await bareGit.raw(["update-ref", "-d", refName]);
  }

  async listRefs(prefix: string): Promise<string[]> {
    const bareGit = this.getCachedGit(this.bareRepoPath);
    const raw = await bareGit.raw(["for-each-ref", "--format=%(refname)", prefix]);
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async getLocalBranchCommit(branchName: string): Promise<string | null> {
    const bareGit = this.getCachedGit(this.bareRepoPath);
    try {
      return (await bareGit.raw(["rev-parse", `${GIT_CONSTANTS.REFS.HEADS}${branchName}^{commit}`])).trim();
    } catch {
      return null;
    }
  }

  async createBranchAt(branchName: string, sha: string): Promise<void> {
    const bareGit = this.getCachedGit(this.bareRepoPath);
    await bareGit.raw(["branch", branchName, sha]);
  }

  async deleteLocalBranch(branchName: string): Promise<void> {
    const bareGit = this.getCachedGit(this.bareRepoPath);
    await bareGit.raw(["branch", "-D", branchName]);
  }

  // Compare-and-swap delete: removes the branch ref only while it still
  // points at expectedOid, so a commit racing the removal pipeline keeps its
  // ref instead of being orphaned by an unconditional `branch -D`.
  async deleteLocalBranchIfAt(branchName: string, expectedOid: string): Promise<void> {
    const bareGit = this.getCachedGit(this.bareRepoPath);
    await bareGit.raw(["update-ref", "-d", `${GIT_CONSTANTS.REFS.HEADS}${branchName}`, expectedOid]);
  }

  // Bundles only commits not reachable from any remote — for fully-pushed
  // refs that set is empty and `bundle create` would fail. Emptiness is
  // pre-checked with rev-list (locale-independent) instead of parsing git's
  // localized "empty bundle" stderr; after the pre-check, any bundle-create
  // error is a real failure the caller must treat as fail-closed.
  async createBundleFromRef(bundlePath: string, refName: string): Promise<boolean> {
    const bareGit = this.getCachedGit(this.bareRepoPath);
    const count = (await bareGit.raw(["rev-list", "--count", refName, "--not", "--remotes"])).trim();
    if (count === "0") {
      return false;
    }
    await bareGit.raw(["bundle", "create", bundlePath, refName, "--not", "--remotes"]);
    return true;
  }

  // Registers the worktree and writes its .git link without populating files —
  // restore overlays the preserved payload instead of a fresh checkout.
  async addWorktreeNoCheckout(branchName: string, worktreePath: string): Promise<void> {
    const bareGit = this.getCachedGit(this.bareRepoPath);
    const absoluteWorktreePath = path.resolve(worktreePath);
    await fs.mkdir(path.dirname(absoluteWorktreePath), { recursive: true });
    await bareGit.raw(["worktree", "add", "--no-checkout", absoluteWorktreePath, branchName]);
  }

  // Mixed reset: points the index at HEAD without touching working files, so
  // overlaid payload content shows up as ordinary uncommitted changes.
  async resetWorktreeIndex(worktreePath: string): Promise<void> {
    const worktreeGit = this.getCachedGit(worktreePath);
    await worktreeGit.raw(["reset"]);
  }

  // Injected by WorktreeSyncService when trash is enabled, so stale-directory
  // cleanup follows the same reversible-removal pipeline as everything else.
  // GitService cannot own a TrashService directly (TrashService depends on it).
  private staleDirectoryTrasher: ((dirPath: string) => Promise<string>) | null = null;

  setStaleDirectoryTrasher(trasher: (dirPath: string) => Promise<string>): void {
    this.staleDirectoryTrasher = trasher;
  }

  // A stale directory that contains a .git may be a live checkout that git
  // failed to report; quarantine it instead of deleting.
  private async clearStaleWorktreeDirectory(absoluteWorktreePath: string): Promise<void> {
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

    if (gitProbe === "exists") {
      const quarantinePath = await quarantineDirectory(absoluteWorktreePath);
      this.logger.warn(
        `  - ⚠️ Directory at '${absoluteWorktreePath}' contains a .git; quarantined to '${quarantinePath}' instead of deleting.`,
      );
      return;
    }

    await fs.rm(absoluteWorktreePath, { recursive: true, force: true });
  }

  async checkWorktreeStatus(worktreePath: string): Promise<boolean> {
    return this.statusService.checkWorktreeStatus(worktreePath);
  }

  async hasStashedChanges(worktreePath: string): Promise<boolean> {
    return this.statusService.hasStashedChanges(worktreePath);
  }

  async getFullWorktreeStatus(worktreePath: string, includeDetails = false): Promise<WorktreeStatusResult> {
    const metadata = await this.metadataService.loadMetadataFromPath(this.bareRepoPath, worktreePath);
    return this.statusService.getFullWorktreeStatus(
      worktreePath,
      includeDetails,
      metadata?.lastSyncCommit,
      metadata?.lastKnownRemoteTip,
    );
  }

  /** Map of remote branch name (without "origin/") → tip oid, from the bare repo. */
  async getRemoteBranchTips(): Promise<Map<string, string>> {
    const git = this.getGit();
    const raw = await git.raw(["for-each-ref", "--format=%(refname)%00%(objectname)", GIT_CONSTANTS.REFS.REMOTES]);
    const tips = new Map<string, string>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [ref, oid] = trimmed.split("\0", 2);
      if (!ref || !oid) continue;
      const branch = GitService.remoteBranchFromRef(ref);
      if (branch === null) continue;
      tips.set(branch, oid);
    }
    return tips;
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

  // refs/remotes/origin/HEAD is a symref that only `remote set-head` writes.
  // `fetch --prune` drops refs/remotes/origin/<old> once the remote renamed or
  // deleted its default branch but leaves the symref pointing at the old
  // name, so it is trusted only while its target is still a remote branch.
  // Otherwise the remote is asked again, and failing that a common default
  // name that does exist is used.
  private async detectDefaultBranch(bareGit: SimpleGit): Promise<string> {
    const remoteBranches = await this.listRemoteBranchNames(bareGit);
    const fromSymref = await this.readOriginHead(bareGit);
    if (fromSymref !== null && (remoteBranches === null || remoteBranches.has(fromSymref))) {
      return fromSymref;
    }

    if (fromSymref !== null) {
      this.logger.info(
        `origin/HEAD points at '${fromSymref}', which no longer exists on origin; asking origin for its default branch...`,
      );
    }
    try {
      // The only command here that talks to the remote, so it runs on the
      // network client (the caller's bareGit is the local one).
      await this.getCachedNetworkGit(this.bareRepoPath).raw(["remote", "set-head", "origin", "-a"]);
      const refreshed = await this.readOriginHead(bareGit);
      if (refreshed !== null) {
        return refreshed;
      }
    } catch (error) {
      this.logger.warn(`Could not read the default branch from origin: ${getErrorMessage(error)}`);
    }

    if (remoteBranches !== null) {
      for (const defaultName of GIT_CONSTANTS.COMMON_DEFAULT_BRANCHES) {
        if (remoteBranches.has(defaultName)) {
          return defaultName;
        }
      }
    }
    // Final fallback
    return GIT_CONSTANTS.DEFAULT_BRANCH;
  }

  // Branch name origin/HEAD points at, or null when the symref is missing or
  // does not name a remote branch.
  private async readOriginHead(bareGit: SimpleGit): Promise<string | null> {
    const originHeadPrefix = `${GIT_CONSTANTS.REFS.REMOTES}/`;
    try {
      const ref = (await bareGit.raw(["symbolic-ref", `${GIT_CONSTANTS.REFS.REMOTES}/HEAD`])).trim();
      const branch = ref.startsWith(originHeadPrefix) ? ref.slice(originHeadPrefix.length) : "";
      return branch.length > 0 ? branch : null;
    } catch {
      return null;
    }
  }

  // null when the listing itself failed, which callers treat as "unknown"
  // rather than "no branches".
  private async listRemoteBranchNames(bareGit: SimpleGit): Promise<Set<string> | null> {
    try {
      return new Set(GitService.remoteBranchNames((await bareGit.branch(["-r", "--no-color"])).all));
    } catch {
      return null;
    }
  }

  setLfsSkipEnabled(value: boolean): void {
    this.lfsSkipOverride = value;
  }

  private isLfsSkipEnabled(): boolean {
    return this.config.skipLfs || this.lfsSkipOverride;
  }

  async getWorktrees(): Promise<RegisteredWorktree[]> {
    const bareGit = this.getCachedGit(this.bareRepoPath);
    return this.getWorktreesFromBare(bareGit);
  }

  // Whether git holds a lock on the registration covering `worktreePath` — a
  // worktree the user asked git to protect, which `worktree remove` refuses
  // while the lock stands. Callers use it to leave such a worktree alone
  // before they move anything. An unregistered path, a detached-HEAD sibling
  // and an unreadable listing all answer "not locked": the caller's own
  // removal reports the real problem, and blocking on a failed listing would
  // stop removals git would happily perform.
  async getWorktreeLock(worktreePath: string): Promise<{ locked: boolean; reason?: string }> {
    const bareGit = this.getCachedGit(this.bareRepoPath);
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

  // How many commits HEAD has that origin/<branch> lacks (ahead) and the
  // other way round (behind), from one
  // `rev-list --left-right --count HEAD...refs/remotes/origin/<branch>`
  // (left = ahead, right = behind). The remote ref is named explicitly — the
  // same ref canFastForward and updateWorktree use — rather than read from
  // `<branch>@{upstream}`, so a branch with no upstream configured (a restored
  // worktree, one created without a push, the no-tracking fallback) is
  // classified like any other instead of passing as up to date. Unrelated
  // histories count on both sides; only a probe that could not run (the ref
  // is gone, git failed to spawn) throws, so a caller never mistakes "cannot
  // determine" for an answer.
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

  // Whether origin/<branch> has commits the worktree's HEAD lacks. A failed
  // probe throws: the runner records update_check_failed for it.
  async isWorktreeBehind(worktreePath: string, branch: string): Promise<boolean> {
    return (await this.getAheadBehindCounts(worktreePath, branch)).behind > 0;
  }

  // Fast-forwards the worktree to origin/<its branch> and reports whether HEAD
  // actually moved, from a sha comparison around the merge rather than from the
  // runner's earlier behind probe: HEAD can reach the remote tip between the
  // two (a `git pull` in the worktree), and `merge --ff-only` succeeds with
  // nothing to bring in. Sync metadata (lastSyncCommit, lastSyncDate, the
  // syncHistory entry) is only written when HEAD moved, so a no-op leaves no
  // trace of an update that did not happen.
  async updateWorktree(worktreePath: string): Promise<WorktreeUpdateResult> {
    const worktreeGit = this.getCachedGit(worktreePath, this.isLfsSkipEnabled());

    const branchSummary = await worktreeGit.branch();
    const currentBranch = branchSummary.current;

    const before = (await worktreeGit.revparse(["HEAD"])).trim();
    await worktreeGit.merge([`origin/${currentBranch}`, "--ff-only"]);
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

  // Whether HEAD is an ancestor of origin/<branch>, so a fast-forward would
  // bring the worktree to the remote tip (equal tips count too). simple-git
  // resolves merge-base's exit 1 — no common ancestor — to an empty string,
  // and that is a genuine "no": unrelated histories cannot fast-forward. Only
  // a probe that could not run throws, so a spawn failure or a `fatal:` is
  // never read as "no" and never sends a healthy worktree into diverged
  // handling; the runner records update_check_failed for it instead.
  async canFastForward(worktreePath: string, branch: string): Promise<boolean> {
    const worktreeGit = this.getCachedGit(worktreePath);
    let mergeBase: string;
    let headSha: string;
    try {
      mergeBase = (await worktreeGit.raw(["merge-base", "HEAD", `origin/${branch}`])).trim();
      headSha = (await worktreeGit.revparse(["HEAD"])).trim();
    } catch (error) {
      throw new GitOperationError(
        "merge-base",
        `could not tell whether '${branch}' in '${worktreePath}' can fast-forward: ${getErrorMessage(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
    // Merge base at HEAD: HEAD is an ancestor of the remote tip.
    return mergeBase !== "" && mergeBase === headSha;
  }

  // Whether origin/<branch> is an ancestor of HEAD, so the worktree only has
  // commits the remote lacks (equal tips count too). Same contract as
  // canFastForward: an empty merge base is "no", a failed probe throws.
  async isLocalAheadOfRemote(worktreePath: string, branch: string): Promise<boolean> {
    const worktreeGit = this.getCachedGit(worktreePath);
    let mergeBase: string;
    let remoteSha: string;
    try {
      mergeBase = (await worktreeGit.raw(["merge-base", "HEAD", `origin/${branch}`])).trim();
      remoteSha = (await worktreeGit.revparse([`origin/${branch}`])).trim();
    } catch (error) {
      throw new GitOperationError(
        "merge-base",
        `could not tell whether '${branch}' in '${worktreePath}' is ahead of origin/${branch}: ${getErrorMessage(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
    // Merge base at the remote tip: the remote is an ancestor of HEAD.
    return mergeBase !== "" && mergeBase === remoteSha;
  }

  async classifyRemoteRelationship(worktreePath: string, branch: string): Promise<RemoteRelationship> {
    const worktreeGit = this.getCachedGit(worktreePath);

    let headSha: string;
    let remoteSha: string;
    try {
      headSha = (await worktreeGit.revparse(["HEAD"])).trim();
      remoteSha = (await worktreeGit.revparse([`refs/remotes/origin/${branch}`])).trim();
    } catch {
      return "diverged";
    }

    if (headSha === remoteSha) return "up_to_date";

    let mergeBase = "";
    let mergeBaseFailed = false;
    try {
      mergeBase = (await worktreeGit.raw(["merge-base", "HEAD", `origin/${branch}`])).trim();
    } catch {
      mergeBaseFailed = true;
    }
    // simple-git swallows merge-base exit 1 and returns "" — treat empty output as failure too.
    if (mergeBaseFailed || !mergeBase) {
      if (await this.isShallowRepository(worktreeGit)) return "indeterminate_shallow";
      return "diverged";
    }
    if (mergeBase === headSha) return "fast_forward";
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

  async getRemoteCommit(ref: string): Promise<string> {
    // Use the bare repository to read remote commit to avoid dependency on main worktree path
    const git = this.getCachedGit(this.bareRepoPath);
    const commit = await git.revparse([ref]);
    return commit.trim();
  }

  async branchExists(branchName: string): Promise<{ local: boolean; remote: boolean }> {
    const bareGit = this.getCachedGit(this.bareRepoPath);
    const [local, remote] = await Promise.all([
      this.refExists(bareGit, `${GIT_CONSTANTS.REFS.HEADS}${branchName}`),
      this.refExists(bareGit, `${GIT_CONSTANTS.REFS.REMOTES}/${branchName}`),
    ]);

    return { local, remote };
  }

  private async refExists(git: SimpleGit, ref: string): Promise<boolean> {
    try {
      // simple-git resolves `show-ref --quiet` when Git exits 1, so keep stdout enabled.
      await git.raw(["show-ref", "--verify", ref]);
      return true;
    } catch {
      return false;
    }
  }

  // Points branch.<name>.remote/merge at origin/<name> when that remote branch
  // is known locally. Sync itself never relies on the upstream — its probes
  // name origin/<name> explicitly — but `git pull`, `git status` and the
  // ahead/behind views in the worktree do, so a branch registered without
  // tracking (a trash restore, `branch --no-track`, the no-tracking add
  // fallback) gets one whenever it can. Resolves to whether it was set and
  // never throws: no remote branch is the normal state of an unpushed branch,
  // and a failure to set it leaves a working worktree, so it is only logged.
  async trackRemoteBranchIfExists(branchName: string, worktreePath: string): Promise<boolean> {
    const bareGit = this.getCachedGit(this.bareRepoPath);
    if (!(await this.refExists(bareGit, `${GIT_CONSTANTS.REFS.REMOTES}/${branchName}`))) {
      return false;
    }
    const upstream = `${GIT_CONSTANTS.REMOTE_PREFIX}${branchName}`;
    try {
      // Config-only: works on a --no-checkout worktree too.
      await this.getCachedGit(worktreePath).raw(["branch", `--set-upstream-to=${upstream}`, branchName]);
      this.logger.info(`  - Set upstream of '${branchName}' to ${upstream}`);
      return true;
    } catch (error) {
      this.logger.warn(`  - ⚠️ Could not set upstream of '${branchName}' to ${upstream}: ${getErrorMessage(error)}`);
      return false;
    }
  }

  private async resolveCreateBranchBaseRef(bareGit: SimpleGit, baseBranch: string): Promise<string> {
    const candidates =
      baseBranch.startsWith(GIT_CONSTANTS.REMOTE_PREFIX) || baseBranch.startsWith("refs/")
        ? [baseBranch]
        : [`${GIT_CONSTANTS.REMOTE_PREFIX}${baseBranch}`, baseBranch];

    for (const candidate of candidates) {
      try {
        await bareGit.revparse(["--verify", candidate]);
        return candidate;
      } catch {
        // Try the next candidate before letting git branch report the original failure.
      }
    }

    return candidates[0];
  }

  async createBranch(branchName: string, baseBranch: string): Promise<void> {
    const bareGit = this.getCachedGit(this.bareRepoPath);
    const baseRef = await this.resolveCreateBranchBaseRef(bareGit, baseBranch);

    await bareGit.raw(["branch", "--no-track", branchName, baseRef]);
    this.logger.info(`Created branch '${branchName}' from '${baseRef}'`);
  }

  async pushBranch(branchName: string): Promise<void> {
    const bareGit = this.getCachedNetworkGit(this.bareRepoPath);

    await bareGit.push(["origin", `${branchName}:${branchName}`, "-u"]);
    this.logger.info(`Pushed branch '${branchName}' to remote`);
  }

  async getWorktreeMetadata(worktreePath: string): Promise<SyncMetadata | null> {
    return this.metadataService.loadMetadataFromPath(this.bareRepoPath, worktreePath);
  }

  private async isRegisteredWorktree(bareGit: SimpleGit, worktreePath: string): Promise<boolean> {
    const absoluteWorktreePath = path.resolve(worktreePath);
    const worktrees = await this.getWorktreesFromBare(bareGit, true);
    return worktrees.some((w) => path.resolve(w.path) === absoluteWorktreePath && !w.isPrunable);
  }

  private async getWorktreesFromBare(bareGit: SimpleGit, includeDetached = false): Promise<RegisteredWorktree[]> {
    const result = await bareGit.raw(["worktree", "list", "--porcelain"]);
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
      }));
  }
}
