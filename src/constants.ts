export const GIT_CONSTANTS = {
  REMOTE_PREFIX: "origin/",
  REMOTE_NAME: "origin",
  HEAD_REF: "/HEAD",
  DEFAULT_BRANCH: "main",
  BARE_DIR_NAME: ".bare",
  DIVERGED_DIR_NAME: ".diverged",
  REFS: {
    HEADS: "refs/heads/",
    REMOTES: "refs/remotes/origin",
    REMOTES_ORIGIN: "refs/remotes/origin/*",
  },
  FETCH_CONFIG: "+refs/heads/*:refs/remotes/origin/*",
} as const;

export const GIT_OPERATIONS = {
  MERGE_HEAD: "MERGE_HEAD",
  CHERRY_PICK_HEAD: "CHERRY_PICK_HEAD",
  REVERT_HEAD: "REVERT_HEAD",
  BISECT_LOG: "BISECT_LOG",
  REBASE_MERGE: "rebase-merge",
  REBASE_APPLY: "rebase-apply",
} as const;

export const DEFAULT_CONFIG = {
  CRON_SCHEDULE: "0 * * * *",
  RETRY: {
    MAX_ATTEMPTS: 3,
    MAX_LFS_RETRIES: 2,
    INITIAL_DELAY_MS: 1000,
    MAX_DELAY_MS: 30000,
    BACKOFF_MULTIPLIER: 2,
    JITTER_MS: 500,
  },
  PARALLELISM: {
    MAX_REPOSITORIES: 2,
    MAX_WORKTREE_CREATION: 1,
    MAX_WORKTREE_UPDATES: 3,
    MAX_WORKTREE_REMOVAL: 3,
    MAX_STATUS_CHECKS: 20,
    MAX_SAFE_TOTAL_CONCURRENT_OPS: 100,
  },
  UPDATE_EXISTING_WORKTREES: true,
} as const;

export const ERROR_MESSAGES = {
  GIT_NOT_INITIALIZED: "Git service not initialized. Call initialize() first.",
  ALREADY_EXISTS: "already exists",
  ALREADY_REGISTERED: "already registered worktree",
  FAST_FORWARD_FAILED: [
    "Not possible to fast-forward",
    "fatal: Not possible to fast-forward, aborting",
    "cannot fast-forward",
  ],
  NO_UPSTREAM: [
    "fatal: no upstream configured",
    "no upstream configured for branch",
    "fatal: ambiguous argument",
    "unknown revision or path",
  ],
  LFS_ERROR: ["smudge filter lfs failed", "git-lfs", "LFS"],
  EXDEV: "EXDEV",
} as const;

export const TEST_TIMEOUT = {
  DEFAULT: 10000,
  E2E: 60000,
} as const;

export const PATH_CONSTANTS = {
  GIT_DIR: ".git",
  README: "README",
} as const;

export const METADATA_CONSTANTS = {
  MAX_HISTORY_ENTRIES: 10,
} as const;
