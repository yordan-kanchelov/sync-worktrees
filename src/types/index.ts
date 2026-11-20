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

export interface RepoLockUnavailable {
  reason: "lock_unavailable";
  path: string;
  code?: string;
  error: string;
}

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
  maintenance?: MaintenanceConfig;
  trash?: TrashConfig;
  mode?: RepositoryMode;
  branch?: string;
  depth?: number;
  fetchTimeoutMs?: number;
  cloneTimeoutMs?: number;
  __configFileDir?: string;
  __configuredRepoDirs?: string[];
}

export interface RepositoryConfig extends Config {
  name: string;
}

export interface InitRepositoryInput {
  repoUrl: string;
  worktreeDir: string;
  mode: RepositoryMode;
  bareRepoDir?: string;
  branch?: string;
  depth?: number;
}

export interface InitConfigInput {
  repositories: InitRepositoryInput[];
  cronSchedule: string;
}

export type RepositoryOnlyKey = "repoUrl" | "worktreeDir" | "bareRepoDir";

export interface ConfigFile {
  defaults?: Partial<Omit<Config, RepositoryOnlyKey>>;
  repositories: RepositoryConfig[];
  retry?: RetryConfig;
  parallelism?: ParallelismConfig;
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

export interface KeepRefDropResult {
  deleted: number;
  retained: string[];
  errors: string[];
}

export interface TrashPurgeResult {
  deleted: boolean;
  keepRefsMinted: string[];
  errors: string[];
}

export interface ForceCleanSelection {
  trashEntryIds: string[];
  keepRefNames: string[];
}

export interface ForceCleanPreview extends ForceCleanSelection {
  trashEntries: number;
  trashBytes: number;
  unknownTrashSizes: number;
  invalidTrashEntries: number;
  keepRefs: number;
}

export interface ForceCleanResult extends Omit<ForceCleanPreview, keyof ForceCleanSelection> {
  trashDeleted: number;
  keepRefsDeleted: number;
  keepRefsRetained: number;
  skippedNewEntries: number;
  skippedNewKeepRefs: number;
  gcSucceeded: boolean;
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
