// User-authored config types, kept free of service imports so the published
// declarations stop here. Re-exported from ./index.
export interface RetryConfig {
  maxAttempts?: number | "unlimited";
  maxLfsRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitterMs?: number;
}

export interface HooksConfig {
  onBranchCreated?: string[];
  /**
   * Milliseconds one hook may run before it is SIGTERMed (SIGKILL 5s later).
   * Default 60000, which an install step on a large repository outruns; the
   * ceiling is setTimeout's own, 2147483647. `0` removes the bound entirely,
   * so nothing ever reclaims a wedged hook.
   */
  timeoutMs?: number;
}

export type SparseCheckoutMode = "cone" | "no-cone";

export interface SparseCheckoutConfig {
  include: string[];
  exclude?: string[];
  mode?: SparseCheckoutMode;
  /**
   * Skip fast-forward updates of existing worktrees when the upstream diff
   * does not touch any path inside the sparse-checkout set. Local HEAD lags
   * remote in those cases, but the working tree would have been a no-op
   * anyway — set to false to always update HEAD even when no sparse files
   * change.
   * Only honored in cone mode; no-cone mode always proceeds with the update
   * (gitignore-style pattern matching not implemented here).
   * Default: true.
   */
  skipUpdateWhenOutsideSparse?: boolean;
}

/**
 * Controls concurrency limits for parallel operations.
 * Lower values reduce resource usage but increase total sync time.
 * Higher values speed up syncs but may cause lock contention or resource exhaustion.
 *
 * Every limit below counts git processes. A repository's phases run one after
 * another (create, then prune, then update; the per-branch fetch only as a
 * fallback), so a run peaks at `maxRepositories × the widest single limit` —
 * they are never summed. The config loader rejects a config whose peak exceeds
 * 100; the defaults peak at 2 × 20 = 40.
 *
 * May be set at the top level of the config file, under `defaults`, or on a
 * single repository; each layer overrides the one before it.
 */
export interface ParallelismConfig {
  /** Max concurrent repositories to sync (default: 2). Top level or `defaults` only. */
  maxRepositories?: number;
  /**
   * Max concurrent worktree creations (default: 1).
   * WARNING: Git's worktree.lock file makes parallel creation unsafe.
   * Only increase if you understand the race condition risks. `git worktree
   * add` runs on the bare repository's one git client, whose scheduler stops
   * at 5, so raising this far above 5 mostly does not widen the phase -- each
   * creation also runs a few commands on the new worktree's own client, so the
   * phase grows a little past 5 rather than stopping dead there.
   */
  maxWorktreeCreation?: number;
  /** Max concurrent worktree updates (default: 3) */
  maxWorktreeUpdates?: number;
  /**
   * Max concurrent worktree removals (default: 3). `git worktree remove` runs
   * on the bare repository's one git client, whose scheduler stops at 5, so
   * raising this far above 5 mostly does not widen the phase -- each removal
   * also runs a few commands on the worktree's own client.
   */
  maxWorktreeRemoval?: number;
  /**
   * Max concurrent git processes spent on read-only status probes (default: 20).
   *
   * One status check of a worktree runs up to nine git commands (`status`,
   * `branch`, `branch -r`, `stash list` and `submodule status` at once, then up
   * to four `rev-parse`/`rev-list` probes). They share this one budget across
   * all worktrees, so it is a ceiling on git processes, not on worktrees in
   * flight.
   *
   * Git's own children are extra: `git submodule status` runs a helper script
   * and a child per submodule, measured on git 2.43 at ~1.5 git processes and
   * ~3 processes in total per call on an eight-submodule superproject.
   */
  maxStatusChecks?: number;
  /** @deprecated Has no effect; still accepted so older configs load. */
  maxBranchFetches?: number;
}

export interface MaintenanceConfig {
  /** Enable periodic `git gc`. Default: true. */
  enabled?: boolean;
  /**
   * Minimum time between maintenance runs (duration string, e.g. "7d", "24h").
   * Default: "7d". Throttled via a persisted timestamp so it survives daemon
   * restarts and repeated `runOnce` invocations.
   */
  interval?: string;
  /**
   * When true, run `git gc --prune=now` instead of plain `git gc`. This prunes
   * recently-unreachable objects immediately, bypassing Git's default 2-week
   * grace period. Off by default — only enable for explicit aggressive cleanup.
   * It also takes force clean's gc down to `--prune=now` from the grace window
   * it otherwise uses.
   *
   * Hazard: the repo lock only serializes sync-worktrees processes. Plain git
   * commands run concurrently by you or your IDE can have objects written but
   * not yet ref-anchored; `--prune=now` deletes those with no grace window.
   * Every worktree writes into the same object store, so this covers work in
   * any of them, not just the one you are looking at.
   */
  aggressive?: boolean;
}

export interface TrashConfig {
  /** Route removals through `<worktreeDir>/.trash/` instead of deleting. Default: true. */
  enabled?: boolean;
  /** Days each trashed item is retained before the reaper deletes it. Default: 30. */
  retentionDays?: number;
  /** Log a warning when total trash size exceeds this many bytes. No default (off). */
  warnSizeBytes?: number;
  /**
   * Adopt pre-trash `.removed/` and `.diverged/` entries (exact known dirname
   * formats only) into `.trash/` so they age out under the same retention
   * policy. Default: true.
   */
  migrateLegacy?: boolean;
}

export type RepositoryMode = "clone" | "worktree";

export type SyncWorktreesRetryConfig = RetryConfig;
export type SyncWorktreesParallelismConfig = ParallelismConfig;
export type SyncWorktreesHooksConfig = HooksConfig;
export type SyncWorktreesSparseCheckoutMode = SparseCheckoutMode;
export type SyncWorktreesSparseCheckoutConfig = SparseCheckoutConfig;
export type SyncWorktreesRepositoryMode = RepositoryMode;
export type SyncWorktreesMaintenanceConfig = MaintenanceConfig;
export type SyncWorktreesTrashConfig = TrashConfig;

interface SyncWorktreesCommonConfigFields {
  cronSchedule?: string;
  retry?: SyncWorktreesRetryConfig;
  parallelism?: SyncWorktreesParallelismConfig;
  skipLfs?: boolean;
  debug?: boolean;
  filesToCopyOnBranchCreate?: string[];
  hooks?: SyncWorktreesHooksConfig;
  sparseCheckout?: SyncWorktreesSparseCheckoutConfig;
  maintenance?: SyncWorktreesMaintenanceConfig;
  /** Inactivity timeout (ms) for remote git commands; default 300000, 0 disables. See `Config.fetchTimeoutMs`. */
  fetchTimeoutMs?: number;
  /** Inactivity timeout (ms) for clone-sized git commands; default 900000, 0 disables. See `Config.cloneTimeoutMs`. */
  cloneTimeoutMs?: number;
}

interface SyncWorktreesRepositoryBase extends SyncWorktreesCommonConfigFields {
  name: string;
  repoUrl: string;
  worktreeDir: string;
}

export interface SyncWorktreesCloneRepository extends SyncWorktreesRepositoryBase {
  mode: "clone";
  branch?: string;
  depth?: number;
  bareRepoDir?: never;
  branchMaxAge?: never;
  branchInclude?: never;
  branchExclude?: never;
  updateExistingWorktrees?: never;
  trash?: never;
}

export interface SyncWorktreesWorktreeRepository extends SyncWorktreesRepositoryBase {
  mode?: "worktree";
  bareRepoDir?: string;
  branchMaxAge?: string;
  branchInclude?: string[];
  branchExclude?: string[];
  updateExistingWorktrees?: boolean;
  trash?: SyncWorktreesTrashConfig;
  branch?: never;
  depth?: never;
}

export type SyncWorktreesRepository = SyncWorktreesCloneRepository | SyncWorktreesWorktreeRepository;

interface SyncWorktreesDefaultsBase extends SyncWorktreesCommonConfigFields {
  runOnce?: boolean;
  /**
   * Run one sync immediately when the daemon starts, before the first cron
   * tick. Default: true. Set false to leave the first sync to the schedule.
   * Ignored under `runOnce`, which already syncs once and exits.
   */
  syncOnStart?: boolean;
}

export interface SyncWorktreesCloneDefaults extends SyncWorktreesDefaultsBase {
  mode: "clone";
  branch?: string;
  depth?: number;
  branchMaxAge?: never;
  branchInclude?: never;
  branchExclude?: never;
  updateExistingWorktrees?: never;
  trash?: never;
}

export interface SyncWorktreesWorktreeDefaults extends SyncWorktreesDefaultsBase {
  mode?: "worktree";
  branchMaxAge?: string;
  branchInclude?: string[];
  branchExclude?: string[];
  updateExistingWorktrees?: boolean;
  trash?: SyncWorktreesTrashConfig;
  branch?: never;
  depth?: never;
}

export type SyncWorktreesDefaults = SyncWorktreesCloneDefaults | SyncWorktreesWorktreeDefaults;

export interface SyncWorktreesConfig {
  defaults?: SyncWorktreesDefaults;
  repositories: SyncWorktreesRepository[];
  retry?: SyncWorktreesRetryConfig;
  parallelism?: SyncWorktreesParallelismConfig;
}
