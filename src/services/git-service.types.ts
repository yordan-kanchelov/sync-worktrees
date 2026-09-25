import type { Logger } from "./logger.service";
import type { Config } from "../types";
import type { SimpleGit } from "simple-git";

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
   * branch checked out. `getWorktrees()` omits those unless `includeDetached`
   * asks for them, and `branch` is the empty string on such a row: there is no
   * ref for a caller to fetch, merge or fast-forward.
   */
  detached?: boolean;
  /**
   * The oid `git worktree list --porcelain` printed for this worktree's HEAD.
   * For a worktree on a branch that is refs/heads/<branch> resolved through the
   * worktree's own HEAD symref, so it is the one thing the bare repo's refs
   * cannot tell apart from a detached or mid-operation checkout — and it comes
   * out of the listing every sync already makes, at no extra spawn. Absent when
   * git printed no HEAD line (a prunable registration, the bare repo itself).
   */
  head?: string;
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
  | "parallelism"
>;

/** Options for a git client built outside the per-path cache. */
export interface UncachedGitClientOptions {
  useLfsSkip: boolean;
  /** Extra environment layered over the LFS setting (e.g. GIT_ATTR_SOURCE). */
  extraEnv?: NodeJS.ProcessEnv;
  /** simple-git inactivity kill in ms; 0 means none. */
  blockMs: number;
}

/**
 * What GitService shares with the focused services it is composed of
 * (WorktreeCreationService, WorktreeRegistryService, BranchRefService,
 * BareRepoService, LfsVerificationService). Everything mutable — the logger,
 * the default branch, the per-sync LFS override — is read through a getter on
 * every use, so a change made on GitService (updateLogger, a default-branch
 * switch, setLfsSkipEnabled) reaches every module without re-wiring them.
 * The client accessors hand out GitService's own cached clients, so every
 * module runs a command on exactly the client GitService itself would have.
 */
export interface GitServiceContext {
  readonly config: GitServiceOptions;
  readonly bareRepoPath: string;
  logger(): Logger;
  defaultBranch(): string;
  /** Cached client for local commands: no inactivity kill. */
  localGit(dirPath: string, useLfsSkip?: boolean): SimpleGit;
  /** Cached client for network commands: fetchTimeoutMs is the inactivity kill. */
  networkGit(dirPath: string, useLfsSkip?: boolean): SimpleGit;
  /** A fresh client nothing caches (clone, ls-remote against a URL, one-off env). */
  uncachedGit(dirPath: string | undefined, options: UncachedGitClientOptions): SimpleGit;
  fetchTimeoutMs(): number;
  cloneTimeoutMs(): number;
  isLfsSkipEnabled(): boolean;
  /** Drops every client cached for a path that stopped being a worktree. */
  forgetCachedClients(dirPath: string): void;
}
