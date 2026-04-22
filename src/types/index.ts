import type { Logger } from "../services/logger.service";
import type { WorktreeStatusResult } from "../services/worktree-status.service";

export interface RetryConfig {
  maxAttempts?: number | "unlimited";
  maxLfsRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
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
}

export interface RepositoryConfig extends Config {
  name: string;
}

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

export interface DivergedDirectoryInfo {
  name: string;
  path: string;
  originalBranch: string;
  divergedAt: string;
  sizeBytes: number;
  sizeFormatted: string;
}
