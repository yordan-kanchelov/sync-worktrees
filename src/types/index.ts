import type { Logger } from "../services/logger.service";

export interface RetryConfig {
  maxAttempts?: number | "unlimited";
  maxLfsRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
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
  skipLfs?: boolean;
  updateExistingWorktrees?: boolean;
  debug?: boolean;
  logger?: Logger;
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
