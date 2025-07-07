export interface Config {
  repoPath: string;
  repoUrl?: string;
  worktreeDir: string;
  cronSchedule: string;
  runOnce: boolean;
}

export interface WorktreeStatus {
  branchName: string;
  worktreePath: string;
  hasLocalChanges: boolean;
}
