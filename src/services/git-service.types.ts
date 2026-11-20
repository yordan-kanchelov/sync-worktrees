import type { Logger } from "./logger.service";
import type { Config } from "../types";
import type { SimpleGit } from "simple-git";

export type RemoteRelationship = "up_to_date" | "fast_forward" | "local_ahead" | "diverged" | "indeterminate_shallow";

export interface WorktreeUpdateResult {
  updated: boolean;
  before: string;
  after: string;
}

export interface AheadBehindCounts {
  ahead: number;
  behind: number;
}

export interface RegisteredWorktree {
  path: string;
  branch: string;
  isPrunable?: boolean;
  locked?: boolean;
  lockReason?: string;
  detached?: boolean;
  head?: string;
}

export type AddWorktreeResult =
  { status: "created"; head: string } | { status: "already_registered"; detached: boolean };

export interface DefaultBranchRefresh {
  previous: string;
  defaultBranch: string;
  mainWorktreePath: string;
  created: boolean;
}

export type GitServiceOptions = Pick<
  Config,
  | "mode"
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

export interface UncachedGitClientOptions {
  useLfsSkip: boolean;
  extraEnv?: NodeJS.ProcessEnv;
  blockMs: number;
}

export interface GitServiceContext {
  readonly config: GitServiceOptions;
  readonly bareRepoPath: string;
  logger(): Logger;
  defaultBranch(): string;
  localGit(dirPath: string, useLfsSkip?: boolean): SimpleGit;
  networkGit(dirPath: string, useLfsSkip?: boolean): SimpleGit;
  uncachedGit(dirPath: string | undefined, options: UncachedGitClientOptions): SimpleGit;
  fetchTimeoutMs(): number;
  cloneTimeoutMs(): number;
  isLfsSkipEnabled(): boolean;
  forgetCachedClients(dirPath: string): void;
}
