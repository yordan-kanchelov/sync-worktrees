export const GIT_CONSTANTS = {
  REMOTE_PREFIX: "origin/",
  REMOTE_NAME: "origin",
  DEFAULT_BRANCH: "main",
  COMMON_DEFAULT_BRANCHES: ["main", "master", "develop", "trunk"],
  BARE_DIR_NAME: ".bare",
  DIVERGED_DIR_NAME: ".diverged",
  REMOVED_DIR_NAME: ".removed",
  TRASH_DIR_NAME: ".trash",
  TRASH_REF_PREFIX: "refs/sync-worktrees/trash/",
  KEEP_REF_PREFIX: "refs/sync-worktrees/keep/",
  LFS_HEADER: "version https://git-lfs.github.com/spec/",
  // Column-0 prefixes of `git submodule status`: " " in sync, "-" not
  // initialized, "+" the checked-out commit differs from the superproject's
  // index, "U" merge conflicts. Only "+" and "U" mean the worktree holds
  // submodule state that could be lost — "-" is what `git worktree add` always
  // leaves behind, since it never initializes submodules.
  SUBMODULE_STATUS_OUT_OF_SYNC: "+",
  SUBMODULE_STATUS_CONFLICTED: "U",
  GITDIR_PREFIX: "gitdir:",
  // simple-git validates baseDir when a client is constructed and rejects with
  // this text; like `spawn git ENOENT` from an already-built client, it means
  // the working directory is gone.
  MISSING_BASE_DIR_ERROR: "Cannot use simple-git on a directory that does not exist",
  // simple-git's message fragment for a git command that exited 1. `git grep`
  // uses that exit code for "nothing matched", which is an answer rather than
  // a failure.
  GIT_NO_MATCH_EXIT: "exit code: 1",
  REFS: {
    HEADS: "refs/heads/",
    REMOTES: "refs/remotes/origin",
  },
  FETCH_CONFIG: "+refs/heads/*:refs/remotes/origin/*",
  PROGRESS_BUCKET_PERCENT: 25,
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
    // 0 on purpose, and read by SyncRetryPolicy: jitter only pays off when
    // many repositories retry in lockstep, so it stays an opt-in
    // (`retry.jitterMs`) rather than delay nobody asked for.
    JITTER_MS: 0,
  },
  PARALLELISM: {
    MAX_REPOSITORIES: 2,
    MAX_WORKTREE_CREATION: 1,
    MAX_WORKTREE_UPDATES: 3,
    MAX_WORKTREE_REMOVAL: 3,
    // Also the size of WorktreeStatusService's shared process budget: every
    // status probe of a repository runs through it, so this bounds git
    // processes rather than worktrees.
    MAX_STATUS_CHECKS: 20,
    MAX_BRANCH_FETCHES: 3,
    // Ceiling on concurrent git processes across the whole run, checked by the
    // config loader as maxRepositories × the widest sync phase (phases run one
    // after another, so their limits are never summed, and a phase that shares
    // one git client counts only what that client's scheduler allows). The
    // shipped defaults peak at 2 × 20 = 40.
    MAX_SAFE_TOTAL_CONCURRENT_OPS: 100,
  },
  HOOK_TIMEOUT_MS: 60_000,
  FETCH_TIMEOUT_MS: 300_000,
  CLONE_TIMEOUT_MS: 900_000,
  LOCK_STALE_MS: 600_000,
  LOCK_UPDATE_MS: 30_000,
  // Budget `sync-worktrees trash restore|purge --wait` spends on a repository lock another
  // process holds. Long enough to outlast an ordinary sync tick, short enough
  // that a scripted invocation that will never get the lock still terminates
  // and reports why — this is a bound, not "block until it frees up".
  LOCK_WAIT_MS: 120_000,
  MAINTENANCE: {
    ENABLED: true,
    INTERVAL: "7d",
  },
  TRASH: {
    ENABLED: true,
    RETENTION_DAYS: 30,
    MIGRATE_LEGACY: true,
  },
} as const;

export const ERROR_MESSAGES = {
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
  EXDEV: "EXDEV",
} as const;

export const ENV_CONSTANTS = {
  GIT_LFS_SKIP_SMUDGE: "GIT_LFS_SKIP_SMUDGE",
  GIT_ATTR_SOURCE: "GIT_ATTR_SOURCE",
  /** Set by src/__tests__/setup.ts to the vitest worker's pid; see src/utils/unit-test-shortcut.ts. */
  UNIT_TEST_SHORTCUT: "SYNC_WORKTREES_UNIT_TEST",
  /** Escape hatch that moves the repo lock files out of `<parent of worktreeDir>/.sync-worktrees-locks`;
   * must be set identically for every process sharing a worktreeDir. See src/utils/lock-path.ts. */
  LOCK_DIR: "SYNC_WORKTREES_LOCK_DIR",
} as const;

export const PATH_CONSTANTS = {
  GIT_DIR: ".git",
  CLONE_INIT_MARKER: ".sync-worktrees-clone-init",
  /** Written the moment the clone resolves, before any post-clone step, and
   * removed once the initial file copy lands — its presence marks a
   * tool-created clone whose init was interrupted and still owes the copy. */
  CLONE_INIT_PENDING_MARKER: ".sync-worktrees-clone-init.pending",
  /** Written when a clone this tool started fetched its objects but failed to
   * check out a working tree (git's "Clone succeeded, but checkout failed").
   * Such a directory validates like a user's own clone, so the marker is the
   * only thing that tells the two apart: while it is there the clone is ours
   * and unfinished, and initialize() refuses to adopt it. */
  CLONE_INCOMPLETE_MARKER: ".sync-worktrees-clone-incomplete",
  /** Worktree mode's counterpart, appended to the bare repository's directory
   * name and written in its parent (never inside: `git clone` refuses a
   * non-empty destination). Written only for a destination verified to be
   * absent or empty, and dropped again as soon as the clone ends — on success,
   * and on failure once the destination is verifiably gone or empty. So a
   * HEAD-less directory next to this marker is a leftover of this tool's own
   * initialization, the only one initialize() may delete. */
  BARE_CLONE_PENDING_MARKER_SUFFIX: ".sync-worktrees-bare-clone.pending",
  /** Directory next to (never inside) a worktreeDir that holds its cross-process lock file. */
  LOCK_DIR_NAME: ".sync-worktrees-locks",
  /** Directory under the config file's directory that holds per-config state (removal audit logs). */
  STATE_DIR_NAME: ".sync-worktrees-state",
} as const;

// `.ts` is in the list because Node runs it directly: type stripping has been on
// by default since 22.18 and `engines.node` is `>=24`, so every supported runtime
// executes a `.ts` config through the loader's ordinary `import()` — no flag, no
// transpile step, no dependency. Only *erasable* syntax survives that (see
// `typeStrippingHint`), which is all a config needs, because it exports data.
//
// `.mts`/`.cts` are deliberately absent. Every extra name is another stat per
// directory on every level of the walk-up, and the one case `.mts` would buy —
// ESM-TS under a `"type": "commonjs"` package.json — already fails with
// `moduleSyntaxHint` naming the fix. These four are also exactly what the MCP
// instructions and `detect_context` advertise; a fifth would be a fifth claim to
// keep true.
//
// Kept out of the JSDoc below on purpose: `tsc --emitDeclarationOnly` copies a
// JSDoc block attached to an exported declaration into dist/constants.d.ts,
// which ships. Line comments are dropped there and cost nothing.
/** Auto-discovery order for `findConfigUpward` and `findConfigInCwd`; first hit in a directory wins. */
export const CONFIG_FILE_NAMES = [
  "sync-worktrees.config.js",
  "sync-worktrees.config.mjs",
  "sync-worktrees.config.cjs",
  "sync-worktrees.config.ts",
] as const;

export const MAINTENANCE_CONSTANTS = {
  STATE_FILENAME: "sync-worktrees-maintenance.json",
  /**
   * Prune expiry for the gc force clean runs, unless `maintenance.aggressive`
   * opts into `now`. The object store is shared with every checkout, and
   * `--prune=now` deletes objects a concurrent `git commit` has written but not
   * yet anchored to a ref.
   *
   * What the window costs in reclamation depends on how the objects are stored,
   * because expiry reads the mtime of the FILE CURRENTLY HOLDING an object, not
   * the age of the commit and not when it stopped being reachable. A loose
   * object carries its own mtime, so the commits a purged recovery ref was
   * holding are still collected on the same run. A packed object inherits its
   * pack's mtime, and a repack resets that clock for everything in the new
   * pack — so when the store was repacked inside the window (force clean packs;
   * so does `gc.auto` after someone's commit) this run reclaims nothing, and
   * the next maintenance run past the hour does it instead. Deferral, not
   * forfeit: cruft-pack mtimes are per-object and are not refreshed by repeated
   * gc, so nothing is pinned indefinitely.
   */
  FORCE_CLEAN_PRUNE_EXPIRE: "1.hour.ago",
} as const;

export const TRASH_CONSTANTS = {
  MANIFEST_FILENAME: "manifest.json",
  PAYLOAD_DIRNAME: "payload",
  BUNDLE_FILENAME: "commits.bundle",
  /** Prefix of a payload that has been set aside for deletion — see src/utils/trash-container.ts. */
  DELETING_PREFIX: "payload.deleting-",
  SCHEMA_VERSION: 1,
} as const;

export const METADATA_CONSTANTS = {
  MAX_HISTORY_ENTRIES: 10,
  METADATA_FILENAME: "sync-metadata.json",
  WORKTREE_METADATA_PATH: ".git/worktrees",
  DIVERGED_INFO_FILE: ".diverged-info.json",
  DIVERGED_REASON: "diverged-history-with-changes",
} as const;

// DEFAULT_EXEC_FLAG makes most emulators run their trailing argv as a program; the emulators in
// EXEC_FLAG_OVERRIDES take one string after `-e` instead, so `-e sh -c <cmd>` would run a bare
// `sh` or die on the unknown `-c`. Kept beside LINUX_CANDIDATES so the two cannot drift, and
// above the statement rather than on the members: esbuild ships a comment that leads an
// object-literal member (scripts/smoke-test.mjs), and these two cost 278 bytes there.
export const TERMINAL_CONSTANTS = {
  ENV_OVERRIDE: "SYNC_WORKTREES_TERMINAL",
  ENV_FALLBACK: "TERMINAL",
  LINUX_CANDIDATES: ["gnome-terminal", "konsole", "alacritty", "kitty", "xterm"],
  DEFAULT_EXEC_FLAG: "-e",
  EXEC_FLAG_OVERRIDES: {
    "gnome-terminal": "--",
    "mate-terminal": "--",
    "xfce4-terminal": "-x",
  },
} as const;

export const HOOK_CONSTANTS = {
  ENV_VARS: {
    BRANCH_NAME: "SYNC_WORKTREES_BRANCH_NAME",
    WORKTREE_PATH: "SYNC_WORKTREES_WORKTREE_PATH",
    REPO_NAME: "SYNC_WORKTREES_REPO_NAME",
    BASE_BRANCH: "SYNC_WORKTREES_BASE_BRANCH",
    REPO_URL: "SYNC_WORKTREES_REPO_URL",
  },
  PLACEHOLDERS: {
    BRANCH_NAME: "{BRANCH_NAME}",
    WORKTREE_PATH: "{WORKTREE_PATH}",
    REPO_NAME: "{REPO_NAME}",
    BASE_BRANCH: "{BASE_BRANCH}",
    REPO_URL: "{REPO_URL}",
  },
} as const;
