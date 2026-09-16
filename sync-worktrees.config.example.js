// @ts-check

/**
 * Example configuration file for sync-worktrees
 *
 * This file demonstrates various ways to configure multiple repositories
 * for automatic Git worktree synchronization.
 */

import os from "os";
import path from "path";

/** @satisfies {import("sync-worktrees").SyncWorktreesConfig} */
const config = {
  // Global defaults for all repositories (optional)
  defaults: {
    // Default cron schedule: every hour
    cronSchedule: "0 * * * *",
    // By default, run as a scheduled job (not one-time)
    runOnce: false,
    // Sync once as soon as the daemon starts, before the first cron tick
    // (default: true). Set false to wait for the schedule instead. Whole-file
    // like `runOnce`, and ignored when `runOnce` is on.
    // syncOnStart: false,
    // Maximum age of branches to sync (optional)
    // branchMaxAge: "30d",  // Only sync branches active in last 30 days
    // Skip Git LFS downloads (optional)
    // skipLfs: true,  // Skip downloading large files tracked by Git LFS
    // Auto-update worktrees that are behind upstream (optional)
    // updateExistingWorktrees: true,  // Default: true, set to false to disable updates
    // Inactivity timeouts (optional) for the git commands that talk to the
    // remote. Each kills its command when no output arrives inside its window,
    // so a stalled connection ends the attempt instead of hanging the sync
    // forever; `0` disables one. Local commands (worktree add, merge, checkout,
    // status) never carry them — a large checkout is silent for minutes by
    // design, and killing it there would fail a creation that only needed more
    // time. Settable here and on a single repository, which overrides this.
    //   fetchTimeoutMs covers fetch, push, ls-remote and remote set-head.
    //   cloneTimeoutMs covers the initial clone and the `fetch --unshallow` that
    //   pulls a clone-mode repository's full history once `depth` is removed —
    //   clone-sized work reached through a fetch, which is why it is the larger
    //   of the two.
    // fetchTimeoutMs: 300000, // Default: 300000 ms = 5 min.
    // cloneTimeoutMs: 900000, // Default: 900000 ms = 15 min.
    // Periodic `git gc` of the object store (optional, applies to both modes).
    // Reclaims unreachable objects and consolidates packs. Runs at the tail of a
    // successful sync, throttled by `interval`, under the repo operation lock.
    // maintenance: {
    //   enabled: true,        // Default: true. Set false to disable entirely.
    //   interval: "7d",       // Default: "7d". Min time between runs (e.g. "24h", "2w").
    //   aggressive: false,    // Default: false. true => `git gc --prune=now` (skips the
    //                         // 2-week grace and prunes recently-unreachable objects now).
    // },
  },

  // Retry configuration for handling transient errors (optional)
  retry: {
    maxAttempts: "unlimited", // Maximum retry attempts ('unlimited' or number)
    maxLfsRetries: 2, // Maximum retry attempts for LFS errors (default: 2)
    initialDelayMs: 1000, // Initial delay: 1 second
    maxDelayMs: 600000, // Maximum delay: 10 minutes
    backoffMultiplier: 2, // Doubles delay each retry (1s, 2s, 4s, 8s...)
    jitterMs: 500, // Random jitter (0-500ms) to prevent thundering herd (default: 0)
  },

  // Simple retry presets (uncomment one):
  // retry: { maxAttempts: 5 },                    // Try 5 times then stop
  // retry: { maxAttempts: 'unlimited' },          // Keep trying forever
  // retry: { maxLfsRetries: 0 },                  // Don't retry LFS errors at all
  // retry: { maxDelayMs: 60000 },                 // Cap retry delay at 1 minute
  // retry: { initialDelayMs: 5000 },              // Start with 5 second delay
  // retry: { jitterMs: 1000 },                    // Add up to 1s random jitter for concurrent ops

  // Parallelism configuration for performance tuning (optional).
  // Every limit below counts git processes. This block may also go under
  // `defaults:` or on a single repository, which override it in that order.
  parallelism: {
    maxRepositories: 2, // Max concurrent repositories to sync (default: 2)
    maxWorktreeCreation: 1, // Max concurrent worktree creations (default: 1 - KEEP LOW!)
    maxWorktreeUpdates: 3, // Max concurrent worktree updates (default: 3)
    maxWorktreeRemoval: 3, // Max concurrent worktree removals (default: 3)
    maxStatusChecks: 20, // Max concurrent git processes for status probes (default: 20)
    maxBranchFetches: 3, // Max concurrent per-branch fetches, bulk-fetch fallback (default: 3)
  },

  // Performance tuning tips:
  // - maxWorktreeCreation: Keep at 1 to avoid Git lock contention issues
  // - maxStatusChecks: Safe to increase (20-50) since they're read-only. One
  //   status check of a worktree runs up to nine git commands (status, branch,
  //   branch -r, stash list and submodule status at once, then rev-parse and
  //   rev-list probes); they all share this one budget, so it caps git
  //   processes, not worktrees. Git's own children are extra:
  //   `git submodule status` runs a helper script and a child per submodule,
  //   about 3 processes per call on an 8-submodule superproject.
  // - maxWorktreeUpdates: Can safely increase to 5-10 on fast systems
  // - maxWorktreeCreation, maxWorktreeRemoval and maxBranchFetches each run
  //   their main git command through one shared client that stops at 5
  //   concurrent processes, so raising them far above 5 buys little: fetches
  //   stop at 5 outright, while creation and removal grow a little past it for
  //   the few commands they run on each worktree's own client
  // - maxRepositories: Higher values speed up multi-repo syncs but use more resources
  // - A repository's phases run one after another (create, then prune, then
  //   update), so peak git processes = maxRepositories × the widest single
  //   limit — never their sum. That peak must be ≤ 100.
  // - On powerful machines with SSDs, you can increase these values for better performance
  // - Use jitterMs in retry config to prevent all concurrent operations from retrying at once
  // - Example safe config: maxRepositories=2, maxStatusChecks=20 = a peak of 40 git processes

  // Array of repository configurations
  repositories: [
    {
      // Unique name for this repository configuration
      name: "my-main-project",

      // Git repository URL (required)
      repoUrl: "https://github.com/user/my-main-project.git",

      // Directory where worktrees will be created
      worktreeDir: path.join(os.homedir(), "projects", "my-main-project-worktrees"),

      // Override default schedule for this repo (every 15 minutes)
      cronSchedule: "*/15 * * * *",
    },

    {
      name: "work-project",

      // Using environment variables for sensitive data
      repoUrl: process.env.WORK_REPO_URL || "git@github.com:company/work-project.git",

      // Relative paths are resolved from the config file location
      worktreeDir: "./worktrees/work-project",

      // Only sync during business hours on weekdays
      cronSchedule: "0 9-17 * * 1-5",
    },

    {
      name: "documentation",

      repoUrl: "https://github.com/user/documentation.git",
      worktreeDir: "/home/user/docs/docs-worktrees",

      // Uses global defaults for cronSchedule and runOnce
    },

    {
      name: "experimental-features",

      repoUrl: "https://github.com/user/experimental.git",
      worktreeDir: path.join(os.homedir(), "experiments", "worktrees"),

      // Custom bare repository location
      bareRepoDir: path.join(os.homedir(), "experiments", ".bare", "experimental"),

      // To sync only when manually triggered, set `runOnce: true` under
      // `defaults` above, or pass `--runOnce` for a single invocation.
      // `runOnce` is a whole-file setting — one process runs every repository
      // in the config, so it cannot be scheduled for some and one-shot for
      // others. Setting it on a repository entry is a validation error.

      // Repository-specific retry configuration (overrides global)
      retry: {
        maxAttempts: 10, // Try 10 times for experimental repo
        initialDelayMs: 2000, // Start with 2 second delay
      },

      // Repository-specific parallelism configuration (overrides global)
      parallelism: {
        maxStatusChecks: 50, // This repo has many branches, check them faster
        maxWorktreeUpdates: 5, // Can handle more concurrent updates
      },
    },

    {
      name: "active-development",

      repoUrl: "https://github.com/user/active-dev.git",
      worktreeDir: "./worktrees/active-dev",

      // Only sync branches that have been active in the last 2 weeks
      branchMaxAge: "14d",

      // Check for updates every 30 minutes
      cronSchedule: "*/30 * * * *",

      // Reversible removals (optional). Branches that age out of branchMaxAge
      // are removed every tick, so this is where retention matters most.
      // Each removal moves the directory to `<worktreeDir>/.trash/<id>/` with a
      // manifest and a pin ref (`refs/sync-worktrees/trash/<root-hash>/<id>`)
      // that keeps the trashed HEAD's objects alive through `git gc` for the
      // retention window; a reaper deletes expired entries at the tail of every
      // sync attempt, failed ones included, so a repository whose fetch keeps
      // failing still expires its trash (the periodic `git gc` above is the
      // success-only one). Inspect and recover with `sync-worktrees trash`.
      // Worktree mode only: clone mode never removes its checkout, and `trash`
      // on a clone-mode repository — or under `defaults`, which every
      // clone-mode repository in the file inherits — is a validation error.
      trash: {
        enabled: true, // Default: true. false deletes removals outright.
        retentionDays: 14, // Default: 30. Days an entry is kept before the reaper deletes it.
        warnSizeBytes: 5368709120, // No default (off). Warn once the trash exceeds this many bytes (5 GiB here).
        migrateLegacy: true, // Default: true. Adopt pre-trash `.removed/` and `.diverged/` entries into `.trash/`.
      },
    },

    {
      name: "legacy-project",

      repoUrl: "https://github.com/user/legacy.git",
      worktreeDir: "./worktrees/legacy",

      // For legacy projects, only sync branches active in last 6 months
      branchMaxAge: "6m",

      // Check less frequently - once per day
      cronSchedule: "0 0 * * *",
    },

    {
      name: "filtered-branches",

      repoUrl: "https://github.com/user/filtered.git",
      worktreeDir: "./worktrees/filtered",

      // Only sync feature and release branches
      branchInclude: ["feature/*", "release-*"],

      // Exclude WIP branches even within the included patterns
      branchExclude: ["feature/wip-*"],

      // Can combine with age filtering - name filter runs first
      branchMaxAge: "30d",
    },

    {
      name: "large-media-project",

      repoUrl: "https://github.com/user/large-media.git",
      worktreeDir: "./worktrees/large-media",

      // Skip downloading LFS files to save bandwidth and disk space
      skipLfs: true,

      // This remote is slow to enumerate objects for a repository this size, and
      // those phases are silent: allow 15 minutes of quiet per fetch instead of
      // the default 5. Set 0 here to disable the inactivity kill for this repo.
      fetchTimeoutMs: 900000,

      // Still check regularly for code changes
      cronSchedule: "0 * * * *",
    },

    // Sparse-checkout: clone only a subset of folders from a monorepo.
    // The same repoUrl can be listed multiple times under different `name`s
    // with different sparse patterns and worktreeDirs to build domain-grouped layouts.
    {
      name: "monorepo-game-client",
      repoUrl: "https://github.com/acme/casino-monorepo.git",
      worktreeDir: "/Users/me/game-clients/roulette",
      sparseCheckout: {
        // Cone mode (default): pass folder names; fast and recommended
        include: ["game-client"],

        // Default: true. When an upstream change touches nothing inside the
        // sparse set, the fast-forward is skipped rather than run: the working
        // tree would not have changed either way, so HEAD is deliberately left
        // behind the remote. Set false to always fast-forward.
        // Honoured in cone mode only — no-cone always proceeds with the update.
        // If the diff cannot be read, the update goes ahead rather than being
        // treated as "nothing sparse was touched".
        skipUpdateWhenOutsideSparse: true,
      },
    },
    {
      name: "monorepo-autocue",
      repoUrl: "https://github.com/acme/casino-monorepo.git",
      worktreeDir: "/Users/me/autocues/roulette",
      sparseCheckout: { include: ["autocue"] },
      // Optional: pin bareRepoDir to make config order irrelevant.
      // Without this pin, the FIRST entry per repoUrl gets .bare/<repo-slug>
      // and subsequent duplicates auto-derive .bare/<sanitized-name>.
      // bareRepoDir: ".bare/monorepo-autocue"
    },
    {
      name: "monorepo-with-excludes",
      repoUrl: "https://github.com/acme/casino-monorepo.git",
      worktreeDir: "/Users/me/casino/all-but-docs",
      sparseCheckout: {
        // No-cone mode: gitignore-style patterns, supports !-negation.
        // Setting `exclude` auto-promotes mode to "no-cone".
        include: ["/*"],
        exclude: ["docs", "vendor"],
      },
    },

    {
      name: "read-only-reference",

      repoUrl: "https://github.com/user/reference.git",
      worktreeDir: "./worktrees/reference",

      // Disable automatic updates for read-only reference repositories
      updateExistingWorktrees: false,

      // Check less frequently since we won't update
      cronSchedule: "0 0 * * 0", // Once per week
    },

    {
      name: "project-with-hooks",

      repoUrl: "https://github.com/user/project.git",
      worktreeDir: "./worktrees/project",

      // Hooks configuration - commands to run on specific lifecycle events
      // All hooks run in background (fire-and-forget) and log output to UI
      // Platform: commands are executed by a POSIX shell (macOS/Linux only).
      // Windows/cmd.exe syntax is not supported — Windows support was dropped
      // intentionally. Use a Node cross-platform script if Windows is required.
      hooks: {
        // Commands to run after creating a new branch worktree via the 'c' command
        // Available placeholders: {BRANCH_NAME}, {WORKTREE_PATH}, {REPO_NAME}, {BASE_BRANCH}, {REPO_URL}
        // Also available as env vars: SYNC_WORKTREES_BRANCH_NAME, SYNC_WORKTREES_WORKTREE_PATH, etc.
        // POSIX-safe example: single quotes preserve the placeholder value verbatim
        //   "sh -c 'cd \"$SYNC_WORKTREES_WORKTREE_PATH\" && pnpm install'"
        onBranchCreated: [
          // Open VS Code in the new worktree
          "code {WORKTREE_PATH}",

          // Open a new terminal window in the worktree (macOS)
          // "open -a 'Terminal' {WORKTREE_PATH}",

          // Open Ghostty terminal in the worktree directory
          // "ghostty --working-directory={WORKTREE_PATH}",

          // Start a tmux session with the branch name
          // "tmux new-session -d -s {BRANCH_NAME} -c {WORKTREE_PATH}",

          // Run a custom setup script using environment variables
          // "cd $SYNC_WORKTREES_WORKTREE_PATH && ./setup-dev.sh"
        ],
      },
    },

    // Clone mode: one checked-out branch directly into worktreeDir (no worktreeDir/<branch> subfolder).
    // Use when sibling monorepo dependencies must live at fixed relative paths.
    //
    // - mode: "clone" disables the bare-repo + per-branch-worktree layout for this repo.
    // - branch is optional; when omitted, remote HEAD is resolved via `git ls-remote --symref`.
    // - origin tracks only the checked-out branch. Branch discovery uses remote
    //   metadata instead of materializing every origin/* ref locally.
    // - depth is optional and config-file only; it maps to `git clone --depth <N>` on the
    //   initial single-branch clone. Routine sync fetches keep a --depth cap, because a
    //   shallow clone has no ancestors to offer the server: the moment the remote tip is
    //   not a descendant of the clone's tip (a force-push, a rebase) an uncapped fetch has
    //   to pack the new tip's whole ancestry. The cap is ratcheted to
    //   max(depth, the window the clone already holds under origin/<branch>), so it can
    //   never ask for a shorter window than the ref it caps holds — `git fetch --depth N`
    //   re-applies N to the ref it fetches rather than capping at it, and passing the
    //   configured value unratcheted re-cut the clone on every tick.
    //   Both are depths in git's unit, counted from the ref the fetch re-applies them to:
    //   --depth N keeps every commit within N parent steps of the fetched tip, so one level
    //   of a merge-built history holds several commits, and the clone's depth is measured
    //   the same way rather than counted in commits — a count is the larger number, and
    //   ratcheting on it would push the boundary deeper every tick until the clone held the
    //   whole repository and depth bounded nothing. The measurement walks origin/<branch>
    //   rather than HEAD, which is the commit --depth is re-applied from only on a tick
    //   that ends in a fast-forward: a tick that fetches and skips the merge (dirty
    //   worktree, unpushed commits, a divergence) leaves HEAD behind the tip, and a cap
    //   measured there shortens the clone on every tick instead of holding it. Measured
    //   from the fetched ref the cap is a fixed point, so a clone stays at the depth its
    //   last deepen left it, and an existing full clone is never converted into a shallow
    //   one.
    //   Raising depth raises the cap, so the next sync fetch deepens a shorter clone up to
    //   the new value — and it shrinks the deepen budget below at the same time, since only
    //   targets above depth are used (at 1000 or more nothing is left). Lowering depth
    //   cannot shorten an existing clone through the sync fetch. Two other fetches re-apply
    //   it verbatim: the
    //   in-sync deepen budget (--depth 50/200/1000), and the fetch used when switching the
    //   clone to another branch or creating a branch from a base branch, which re-applies
    //   the configured value to whatever ref it names — often the tracked branch itself,
    //   since the wizard offers it as a base — and because the shallow boundary is
    //   repository-wide it can re-cut the clone back to that depth or deepen it to a raised
    //   one. If depth is later removed, an existing shallow clone is automatically
    //   unshallowed before normal sync.
    //   Clone-mode clone/fetch operations also use --no-tags.
    // - Conflicts with branchInclude / branchExclude / branchMaxAge / updateExistingWorktrees /
    //   bareRepoDir / trash — setting any of these on a clone-mode repo (or via defaults
    //   inherited into it) is a validation error.
    // - sparseCheckout, filesToCopyOnBranchCreate, and skipLfs still apply.
    //   filesToCopyOnBranchCreate fires exactly once on the initial clone.
    //   hooks.onBranchCreated does NOT fire on the initial clone in clone-mode (clone-mode
    //   tracks a single fixed branch with no later branch-creation event); the hook is
    //   reserved for TUI-initiated branch creation.
    //   sparseCheckout is re-applied every sync (config drift converges).
    // - Lock file lives next to the checkout, at
    //   `<parent of worktreeDir>/.sync-worktrees-locks/<hash>.lock`, where <hash> is the
    //   first 16 hex characters of sha256 over the symlink-resolved worktreeDir — never
    //   inside the cloned repo, so no .gitignore noise, and never under ~/.cache, which
    //   cache cleaners may delete under a live holder. Nothing in the environment feeds
    //   into that path, so a cron/systemd daemon and an interactive run contend for the
    //   same file. `SYNC_WORKTREES_LOCK_DIR` moves the lock directory elsewhere (for a
    //   read-only parent); it is an escape hatch, so give it the same absolute path in
    //   every process that syncs the same worktreeDir.
    //
    // Example: three monorepo-sibling components that import each other via fixed `../` paths.
    {
      name: "game-platform",
      repoUrl: "ssh://git@bitbucket.example.com/cf/game-platform.git",
      worktreeDir: "./slots/game-platform",
      mode: "clone",
      branch: "main",
      depth: 1,
      // Sized for the initial clone and for the `fetch --unshallow` that runs
      // once `depth` is removed from this entry; both move the whole history.
      cloneTimeoutMs: 1800000,
    },
    {
      name: "base-slot",
      repoUrl: "ssh://git@bitbucket.example.com/cf-basic-slot/base-slot.git",
      worktreeDir: "./slots/engines/base-slot",
      mode: "clone",
      branch: "main",
    },
    {
      name: "communicator-base",
      repoUrl: "ssh://git@bitbucket.example.com/cf-components/communicator-base.git",
      worktreeDir: "./slots/communicator-base",
      mode: "clone",
      // No branch → resolves to remote HEAD at clone time.
    },
  ],
};

export default config;

// Advanced example: Dynamic configuration based on environment
/*
const isDevelopment = process.env.NODE_ENV === 'development';

export default {
  defaults: {
    cronSchedule: isDevelopment ? "*\/5 * * * *" : "0 * * * *",
    runOnce: false
  },

  repositories: [
    // Filter repositories based on environment
    ...(isDevelopment ? [{
      name: "dev-only-repo",
      repoUrl: "https://github.com/user/dev-repo.git",
      worktreeDir: "./dev/worktrees"
    }] : []),

    // Always include production repos
    {
      name: "production-app",
      repoUrl: process.env.PROD_REPO_URL,
      worktreeDir: "/var/apps/production-worktrees",
      cronSchedule: "0 *\/6 * * *"  // Every 6 hours
    }
  ]
};
*/
