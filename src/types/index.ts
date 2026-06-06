import type { Logger } from "../services/logger.service";
import type { WorktreeStatusResult } from "../services/worktree-status.service";

export interface RetryConfig {
  maxAttempts?: number | "unlimited";
  maxLfsRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitterMs?: number;
}

export interface HookContext {
  branchName: string;
  worktreePath: string;
  repoName: string;
  baseBranch: string;
  repoUrl: string;
}

export interface HooksConfig {
  onBranchCreated?: string[];
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
 * Note: Total concurrent operations can be maxRepositories × per-repo limits.
 * Tune these values based on your system resources and repository count.
 */
export interface ParallelismConfig {
  /** Max concurrent repositories to sync (default: 2) */
  maxRepositories?: number;
  /**
   * Max concurrent worktree creations (default: 1).
   * WARNING: Git's worktree.lock file makes parallel creation unsafe.
   * Only increase if you understand the race condition risks.
   */
  maxWorktreeCreation?: number;
  /** Max concurrent worktree updates (default: 3) */
  maxWorktreeUpdates?: number;
  /** Max concurrent worktree removals (default: 3) */
  maxWorktreeRemoval?: number;
  /** Max concurrent status checks (default: 20) */
  maxStatusChecks?: number;
  /** Max concurrent per-branch fetches when falling back from bulk fetch (default: 3) */
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

export type SyncResult =
  | { started: true; outcome: SyncOutcome }
  | { started: false; reason: "in_progress" }
  | { started: false; reason: "locked" };

export interface Config {
  repoUrl: string;
  worktreeDir: string;
  cronSchedule: string;
  runOnce: boolean;
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
   * `git clone --single-branch --no-tags --depth <N>` on initial clone and
   * keeps shallow sync fetches for the tracked branch at the configured depth.
   */
  depth?: number;
  /**
   * Internal: directory of the loaded config file. Used to anchor the lock
   * location for clone-mode repos. Populated by ConfigLoaderService — not
   * a user-facing field.
   */
  __configFileDir?: string;
  /**
   * Inactivity timeout (ms) for fetch/standard git operations.
   * Triggers when no stdout/stderr data arrives within window.
   * Default: 300_000 (5 min). Set 0 to disable.
   */
  fetchTimeoutMs?: number;
  /**
   * Inactivity timeout (ms) for `git clone`. Larger than fetch because
   * server-side pack resolution can be silent for several minutes on big repos.
   * Default: 900_000 (15 min). Set 0 to disable.
   */
  cloneTimeoutMs?: number;
}

export interface RepositoryConfig extends Config {
  name: string;
}

export type InitConfigInput = Pick<
  RepositoryConfig,
  "repoUrl" | "worktreeDir" | "bareRepoDir" | "cronSchedule" | "runOnce"
>;

export interface ConfigFile {
  defaults?: Partial<Config>;
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
}

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
  runOnce?: boolean;
  retry?: SyncWorktreesRetryConfig;
  parallelism?: SyncWorktreesParallelismConfig;
  skipLfs?: boolean;
  debug?: boolean;
  filesToCopyOnBranchCreate?: string[];
  hooks?: SyncWorktreesHooksConfig;
  sparseCheckout?: SyncWorktreesSparseCheckoutConfig;
  maintenance?: SyncWorktreesMaintenanceConfig;
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

type SyncWorktreesDefaultsBase = SyncWorktreesCommonConfigFields;

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
