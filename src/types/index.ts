export interface RetryConfig {
  maxAttempts?: number | "unlimited";
  maxLfsRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

export interface Config {
  repoUrl: string;
  worktreeDir: string;
  cronSchedule: string;
  runOnce: boolean;
  bareRepoDir?: string;
  retry?: RetryConfig;
  branchMaxAge?: string;
  skipLfs?: boolean;
  updateExistingWorktrees?: boolean;
  debug?: boolean;
}

export interface RepositoryConfig extends Config {
  name: string;
}

export interface ConfigFile {
  defaults?: Partial<Config>;
  repositories: RepositoryConfig[];
  retry?: RetryConfig;
}

export interface WorktreeStatus {
  branchName: string;
  worktreePath: string;
  hasLocalChanges: boolean;
}
