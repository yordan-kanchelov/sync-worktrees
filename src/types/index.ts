export interface Config {
  repoPath: string;
  repoUrl?: string;
  worktreeDir: string;
  cronSchedule: string;
  runOnce: boolean;
}

export interface RepositoryConfig extends Config {
  name: string;
}

export interface ConfigFile {
  defaults?: Partial<Config>;
  repositories: RepositoryConfig[];
}

export interface WorktreeStatus {
  branchName: string;
  worktreePath: string;
  hasLocalChanges: boolean;
}
