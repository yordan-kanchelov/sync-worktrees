import type { Logger } from "../services/logger.service";
import type { WorktreeStatusResult } from "../services/worktree-status.service";
import type {
  HooksConfig,
  MaintenanceConfig,
  ParallelismConfig,
  RepositoryMode,
  RetryConfig,
  SparseCheckoutConfig,
  TrashConfig,
} from "./public-config";

export type * from "./public-config";

export interface HookContext {
  branchName: string;
  worktreePath: string;
  repoName: string;
  baseBranch: string;
  repoUrl: string;
}

export type SyncOutcomeMode = RepositoryMode;

export type SyncOutcomeScope = "repo" | "branch" | "worktree" | "sparse-checkout";

export interface SyncOutcomeCounts {
  created: number;
  removed: number;
  updated: number;
  skipped: number;
  preserved: number;
  failed: number;
  noop: number;
}

export type SyncOutcomeAction =
  | { kind: "created"; branch: string; path: string }
  | { kind: "removed"; branch: string; path: string; warning?: string }
  | { kind: "updated"; branch: string; path: string; reason?: string }
  | { kind: "noop"; scope: SyncOutcomeScope; reason: string; branch?: string; path?: string; message?: string }
  | { kind: "skipped"; scope: SyncOutcomeScope; reason: string; branch?: string; path?: string; message?: string }
  | { kind: "preserved-diverged"; branch: string; path: string; preservedPath: string }
  | { kind: "failed"; scope: SyncOutcomeScope; error: string; reason?: string; branch?: string; path?: string };

export interface SyncOutcome {
  repoName?: string;
  mode: SyncOutcomeMode;
  started: true;
  counts: SyncOutcomeCounts;
  actions: SyncOutcomeAction[];
  durationMs?: number;
}

/**
 * The cross-process repository lock could not be taken for a reason other
 * than contention: the lock directory or lock file could not be prepared or
 * locked (ENOTDIR, EACCES, EROFS, ENOSPC, ...). Nothing else holds the lock;
 * this process simply cannot take it, so the operation did not run.
 */
export interface RepoLockUnavailable {
  reason: "lock_unavailable";
  /** Lock directory or lock file that could not be prepared or locked. */
  path: string;
  /** errno code reported by the OS, when there was one. */
  code?: string;
  /** Underlying error message. */
  error: string;
}

/**
 * Why a repository operation did not start. `in_progress` and `locked` are
 * contention (another operation or process is working on the repository) and
 * read as skips; `lock_unavailable` is an infrastructure failure of this run.
 */
export type RepoOperationNotStarted =
  | { started: false; reason: "in_progress" }
  | { started: false; reason: "locked" }
  | ({ started: false } & RepoLockUnavailable);

export type SyncResult = { started: true; outcome: SyncOutcome } | RepoOperationNotStarted;

export interface Config {
  repoUrl: string;
  worktreeDir: string;
  cronSchedule: string;
  runOnce: boolean;
  // Sync once at daemon startup instead of waiting for the first cron tick.
  // Default: true. Whole-file like `runOnce`: the daemon reads it off
  // `defaults`, and it is never resolved onto a repository — it is declared
  // here only because `ConfigFile.defaults` is derived from `Config` and the
  // config schema's `defaults` level is pinned to `keyof Config`. A line
  // comment, not JSDoc: tsc copies a member's JSDoc into the .d.ts and this
  // interface is not the public input surface — SyncWorktreesDefaultsBase
  // below is, and carries the tooltip a config author actually sees.
  syncOnStart?: boolean;
  bareRepoDir?: string;
  retry?: RetryConfig;
  parallelism?: ParallelismConfig;
  branchMaxAge?: string;
  branchInclude?: string[];
  branchExclude?: string[];
  skipLfs?: boolean;
  updateExistingWorktrees?: boolean;
  debug?: boolean;
  logger?: Logger;
  filesToCopyOnBranchCreate?: string[];
  hooks?: HooksConfig;
  sparseCheckout?: SparseCheckoutConfig;
  /**
   * Periodic Git object-store maintenance (`git gc`). Applies to both modes.
   * Reclaims unreachable objects left behind by ref narrowing / branch churn
   * and consolidates pack files. Throttled by `interval` (default 7d) and runs
   * under the repository operation lock at the tail of a successful sync.
   */
  maintenance?: MaintenanceConfig;
  /**
   * Reversible removals: every automatic or manual removal moves the directory
   * into `<worktreeDir>/.trash/<id>/` with a manifest and a pin ref
   * (`refs/sync-worktrees/trash/<id>`) that keeps the trashed HEAD's objects
   * alive through `git gc` for the retention window. A reaper deletes expired
   * items at the tail of a successful sync. Worktree mode only — clone mode
   * never removes its checkout.
   */
  trash?: TrashConfig;
  /**
   * Repository strategy. `worktree` (default) clones once as a bare repo and
   * maintains one worktree per remote branch under `worktreeDir/<branch>`.
   * `clone` performs a normal `git clone --branch <branch>` directly into
   * `worktreeDir` — no bare repo, no branch subfolder, one checked-out branch
   * with normal origin/* remote-tracking refs. Designed for monorepo sibling
   * dependencies that need fixed relative paths.
   */
  mode?: RepositoryMode;
  /**
   * Branch to clone when `mode === "clone"`. If omitted, resolves to the
   * remote default branch via `git ls-remote --symref <url> HEAD`.
   */
  branch?: string;
  /**
   * Shallow clone depth for config-file clone-mode repositories. Maps to
   * `git clone --single-branch --no-tags --depth <N>` on the initial clone.
   *
   * Routine sync fetches keep a `--depth` cap — without one, a remote tip that
   * is not a descendant of the clone's tip (a force-push, a rebase) costs the
   * new tip's whole ancestry, because a shallow clone has no ancestors to
   * offer the server as `have`s — but the cap is ratcheted to
   * `max(depth, the window the clone already holds under origin/<branch>)`, so
   * it can never ask for a shorter window than the ref it caps holds.
   * `git fetch --depth N` re-applies N to the ref it fetches rather than
   * capping at it, so this value passed verbatim cut the clone back to it on
   * every tick and made each remote advance unclassifiable.
   *
   * Both are depths in git's unit, counted from the ref the fetch re-applies
   * them to: `--depth N` keeps every commit within N parent steps of the
   * fetched tip, so one level of a merge-built history holds several commits.
   * The clone is measured the same way — a local
   * `git rev-list --topo-order --parents refs/remotes/origin/<branch>` walk —
   * rather than counted in commits, which is the larger number and would push
   * the boundary deeper every tick until nothing was bounded. The walk starts
   * at the remote-tracking tip and not at HEAD because that is the ref
   * `--depth` is re-applied from; a tick that fetches without merging (dirty
   * worktree, unpushed commits, a divergence) leaves HEAD behind it, and a cap
   * measured there shortens the clone instead of holding it. From the fetched
   * ref the cap is a fixed point: the window a `--depth D` fetch produced
   * measures back as D. HEAD is the fallback only for a first sync, before the
   * remote-tracking ref exists, and a non-shallow clone gets no `--depth`.
   *
   * Editing this value reaches the sync path, asymmetrically. Raising it raises
   * the cap, so the next sync fetch deepens a shorter clone up to the new value
   * — and shrinks the deepen budget at the same time, because only targets
   * above `depth` are used: at 1000 or more there is no budget left, and an
   * unclassifiable clone can then only be skipped. Lowering it cannot shorten
   * an existing clone through the sync fetch. Two other fetches do re-apply it
   * verbatim: the in-sync deepen budget (`--depth 50/200/1000`), and the fetch
   * used when switching the clone to another branch or creating a branch from a
   * base branch — that one re-applies this value to whatever ref it names,
   * often the tracked branch itself since the wizard offers it as a base, and
   * because the shallow boundary is repository-wide it can re-cut the clone
   * back to this depth or deepen it to a raised one. Removing `depth` is the
   * one edit that predictably changes an existing clone: the next sync
   * unshallows it. README.md has the measurements behind all of this.
   */
  depth?: number;
  /**
   * Inactivity timeout (ms) for the git commands that talk to the remote:
   * `fetch`, `push`, `ls-remote` and `remote set-head`. Triggers when no
   * stdout/stderr data arrives within the window, killing the command.
   * Local commands (worktree add, merge, checkout, status, ...) never carry
   * it — they are legitimately silent while a large checkout runs. The one
   * fetch it does not cover is the unshallow, which is sized by
   * cloneTimeoutMs instead.
   * Default: 300_000 (5 min). Set 0 to disable.
   */
  fetchTimeoutMs?: number;
  /**
   * Inactivity timeout (ms) for `git clone` and for the `fetch --unshallow`
   * that pulls a clone-mode repository's full history once `depth` is removed
   * — clone-sized work reached through a fetch. Larger than fetch because
   * server-side pack resolution can be silent for several minutes on big repos.
   * Default: 900_000 (15 min). Set 0 to disable.
   */
  cloneTimeoutMs?: number;
  /**
   * Internal: directory of the loaded config file. Used to anchor the lock
   * location for clone-mode repos. Populated by ConfigLoaderService — not
   * a user-facing field.
   */
  __configFileDir?: string;
  /**
   * Internal: the resolved worktreeDir (and bareRepoDir, in worktree mode) of
   * every repository in the same config file, this one included. Populated by
   * ConfigLoaderService.resolveRepositoryConfig when it is given the full
   * repository list — not a user-facing field.
   *
   * Its one consumer is the `filesToCopyOnBranchCreate` expansion, which must
   * not read out of another repository's checkout whichever directory it is
   * pointed at: the base branch's worktree in worktree mode, the config file's
   * own directory in clone mode — the layout that made this list necessary,
   * since there that directory is the parent of every checkout. See
   * FileCopyOptions.excludeDirs. A config the loader cannot see the whole of (a
   * hand-built Config, a single repository resolved on its own) leaves this
   * unset, and the copy falls back to excluding the destination and this
   * repository's own directories, plus the name-based defaults.
   */
  __configuredRepoDirs?: string[];
}

export interface RepositoryConfig extends Config {
  name: string;
}

export interface InitRepositoryInput {
  repoUrl: string;
  worktreeDir: string;
  mode: RepositoryMode;
  /** worktree mode only */
  bareRepoDir?: string;
  /** clone mode only; omit to track remote HEAD */
  branch?: string;
  /** clone mode only; omit for full history */
  depth?: number;
}

export interface InitConfigInput {
  repositories: InitRepositoryInput[];
  cronSchedule: string;
}

/** Read from a repository's own entry only; `defaults` does not carry them. */
export type RepositoryOnlyKey = "repoUrl" | "worktreeDir" | "bareRepoDir";

export interface ConfigFile {
  defaults?: Partial<Omit<Config, RepositoryOnlyKey>>;
  repositories: RepositoryConfig[];
  retry?: RetryConfig;
  parallelism?: ParallelismConfig;
}

export interface WorktreeStatus {
  branchName: string;
  worktreePath: string;
  hasLocalChanges: boolean;
}

export interface WorktreeStatusEntry {
  branch: string;
  path: string;
  status: WorktreeStatusResult;
  error?: string;
}

export interface RepositoryListEntry {
  index: number;
  name: string;
  repoUrl: string;
}

export interface RepositoryDiskUsage {
  repoIndex: number;
  repoName: string;
  sizeBytes: number | null;
  sizeFormatted: string;
  bareSizeBytes: number;
  worktreeSizeBytes: number;
  error?: string;
}

export interface DivergedDirectoryInfo {
  name: string;
  path: string;
  originalBranch: string;
  divergedAt: string;
  sizeBytes: number;
  sizeFormatted: string;
  keepRef?: string;
}

/**
 * What one batch `--drop-all-keep-refs` run did. Per-ref best effort, like the
 * force-clean loop it mirrors: a ref that could not be deleted is reported and
 * the rest still go.
 */
export interface KeepRefDropResult {
  deleted: number;
  /**
   * Full ref names left alone because a `.diverged/` directory still relies on
   * them — dropping those would leave the directory with dead recovery
   * instructions.
   */
  retained: string[];
  /** `<ref>: <message>` for every ref git refused to delete. */
  errors: string[];
}

/** Outcome of deleting one named trash entry ahead of its expiry. */
export interface TrashPurgeResult {
  /** False when the container survived — `errors` says why, and the entry stays listed. */
  deleted: boolean;
  /**
   * Permanent `refs/sync-worktrees/keep/<id>` refs minted before the payload
   * was deleted, for an entry whose commits were on no remote. Empty is the
   * normal case; a non-empty list is where the commits went.
   */
  keepRefsMinted: string[];
  errors: string[];
}

/**
 * The exact set a force-clean confirmation refers to. A preview is taken
 * outside the repo mutex and confirmed by a human an unbounded time later, so
 * the counts on screen are only a summary of these names — the purge deletes
 * these and nothing else.
 */
export interface ForceCleanSelection {
  /** Trash entry ids (`TrashManifest.id`) the preview counted. */
  trashEntryIds: string[];
  /** Full recovery ref names (`refs/.../keep/<name>`) the preview counted. */
  keepRefNames: string[];
}

export interface ForceCleanPreview extends ForceCleanSelection {
  trashEntries: number;
  trashBytes: number;
  unknownTrashSizes: number;
  invalidTrashEntries: number;
  keepRefs: number;
}

/**
 * Deliberately NOT a {@link ForceCleanSelection}. A result's counts describe
 * what is left AFTER the purge, so its entry ids would name the survivors —
 * exactly what the run was asked to spare. Inheriting the selection fields
 * would let `forceClean(lastResult)` type-check and destroy them.
 */
export interface ForceCleanResult extends Omit<ForceCleanPreview, keyof ForceCleanSelection> {
  trashDeleted: number;
  keepRefsDeleted: number;
  /** Recovery refs left alone because a `.diverged/` directory still relies on them. */
  keepRefsRetained: number;
  /** Trash entries present at purge time but absent from the confirmed selection. */
  skippedNewEntries: number;
  /** Recovery refs present at purge time but absent from the confirmed selection. */
  skippedNewKeepRefs: number;
  gcSucceeded: boolean;
  /**
   * True when the gc was deliberately not run because a git command was in
   * flight, or an operation left half-finished, in a checkout sharing the
   * object store. `errors` names what was found. Distinct from
   * `gcSucceeded: false`, which means the gc ran and failed.
   */
  gcSkipped: boolean;
  errors: string[];
}

export interface ForceCleanRepositoryPreview {
  repoIndex: number;
  repoName: string;
  preview?: ForceCleanPreview;
  error?: string;
}

export interface ForceCleanRepositorySelection extends ForceCleanSelection {
  repoIndex: number;
}

export interface ForceCleanRepositoryResult {
  repoIndex: number;
  repoName: string;
  result?: ForceCleanResult;
  error?: string;
}
