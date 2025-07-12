# sync-worktrees

## 1.4.0

### Minor Changes

- ee7f2be: feat: add Git LFS error handling and skip option
  - Added `--skip-lfs` CLI option to bypass Git LFS downloads when fetching and creating worktrees
  - Added `skipLfs` configuration option for config files
  - Implemented automatic retry with LFS skipping when LFS errors are detected
  - Added branch-by-branch fetching as fallback when fetch-all fails due to LFS errors
  - Enhanced retry mechanism to detect and handle LFS-specific errors
  - Added `maxLfsRetries` configuration to prevent infinite retry loops on persistent LFS errors
  - Improved error resilience for repositories with missing or corrupted LFS objects
  - Fixed E2E tests to handle different Git default branch configurations

## 1.3.2

### Patch Changes

- d9b1690: Fix: Filter out origin/HEAD from branch synchronization

  Previously, the tool would attempt to create a worktree for the special `origin/HEAD` reference, which would fail with the error "'HEAD' is not a valid branch name". This fix ensures that:
  - `origin/HEAD` is filtered out when listing remote branches
  - No worktree creation is attempted for HEAD references
  - The tool can be run multiple times without errors
  - Any orphaned HEAD directories are cleaned up automatically

  This resolves issues when syncing repositories that have `origin/HEAD` pointing to their default branch.

## 1.3.1

### Patch Changes

- e34624d: Fix branchMaxAge configuration not being applied from config files
  - Fixed issue where `branchMaxAge` setting was not being copied during config resolution
  - The branch age filter now properly works when configured in repository-specific or default settings

## 1.3.0

### Minor Changes

- ad8d5d3: Add branch age filtering feature to only sync recently active branches
  - Added `--branchMaxAge` CLI option to filter branches by last commit activity
  - Support for duration formats: hours (h), days (d), weeks (w), months (m), years (y)
  - Can be configured globally or per-repository in config files
  - Helps reduce clutter and save disk space by ignoring stale branches
  - Example: `--branchMaxAge 30d` only syncs branches active in the last 30 days

## 1.2.3

### Patch Changes

- 4deaa7e: Automatically detect and use the repository's default branch instead of hardcoding "main". The tool now:
  - Detects the default branch from the repository's HEAD reference
  - Falls back to common branch names (main, master, develop, trunk) if detection fails
  - Works correctly with repositories using different default branch names

## 1.2.2

### Patch Changes

- acf60f5: Fix worktrees tracking and creation
  - Added fetch before creating main worktree to ensure remote branches exist
  - Better error handling for cases where worktree directories already exist

## 1.2.1

### Patch Changes

- 95690df: Fix worktrees to properly track remote branches

  Worktrees created by sync-worktrees now have proper upstream tracking configured, allowing `git pull` to work without specifying the remote and branch. This was the expected behavior and improves the Git workflow experience when working with synced worktrees.
  - Worktrees are now created with `--track` flag to automatically set up tracking
  - If a local branch already exists, upstream tracking is configured after worktree creation
  - Fallback to non-tracking worktree creation if remote branch doesn't exist yet

## 1.2.0

### Minor Changes

- 2db3401: feat: add comprehensive safety checks to prevent accidental worktree deletion
  - Added stash detection to preserve worktrees with stashed changes
  - Added submodule modification detection to protect worktrees with dirty submodules
  - Added Git operation detection (merge, rebase, cherry-pick, bisect, revert) to prevent deletion during ongoing operations
  - Enhanced error handling with conservative approach - when in doubt, don't delete
  - Improved logging to clearly indicate why each worktree deletion was skipped

  This ensures that no worktree with any type of changes or ongoing operations will be accidentally deleted, providing robust data protection for developers.

## 1.1.0

### Minor Changes

- 5864b09: Add retry mechanism for network and filesystem operations
  - Added configurable retry mechanism with exponential backoff for handling transient failures
  - Sync operations now automatically retry on network errors (ECONNREFUSED, ENOTFOUND, ETIMEDOUT) and filesystem errors (EBUSY, ENOENT, EACCES)
  - Added retry configuration options:
    - `maxAttempts`: Number of retry attempts or "unlimited" (default: 3)
    - `initialDelayMs`: Initial delay between retries (default: 1000ms)
    - `maxDelayMs`: Maximum delay between retries (default: 30s)
    - `backoffMultiplier`: Exponential backoff multiplier (default: 2)
  - Retry configuration can be set globally, in defaults, or per repository
  - Added logging for retry attempts to help with debugging transient failures

## 1.0.0

### Major Changes

- 8fa5c8b: ## 🎉 sync-worktrees v1.0.0 - Stable Release

  This marks the first stable release of sync-worktrees! The tool is now feature-complete and production-ready.

## 0.6.0

### Minor Changes

- 7c16278: Add default worktree directory based on repository name
  - Interactive setup now suggests `./[repo-name]` as the default worktree directory
  - Users can press Enter to accept the default or provide a custom path
  - Reduces the number of required inputs during setup
  - Creates a cleaner directory structure without unnecessary nesting

### Patch Changes

- 7c16278: Fix bare repository path resolution to prevent deletion during cleanup

  When using the current directory as the worktree directory, the bare repository
  was being created with a relative path that would then be incorrectly identified
  as an orphaned directory and deleted during cleanup. This fix ensures the bare
  repository path is always resolved to an absolute path.

## 0.5.1

### Patch Changes

- 1e0743e: Add support for SSH URLs with ssh:// protocol
  - Updated URL validation in interactive mode to accept ssh:// URLs (e.g., ssh://git@bitbucket.com/user/repo.git)

## 0.5.0

### Minor Changes

- 41eb851: feat: implement space-efficient bare repository storage
  - Changed from regular Git repositories to bare repositories with worktrees
  - Replaced `repoPath` CLI parameter with automatic bare repository management
  - All worktrees now share a single Git object database, significantly reducing disk usage
  - Added utilities for Git URL parsing and improved test structure

## 0.4.1

### Patch Changes

- 8d3a34f: Exclude test files from the npm package by updating TypeScript configuration

## 0.4.1

### Patch Changes

- e4970bd: Fix handling of branch names containing slashes
  - Fixed orphaned directory cleanup to properly handle nested directory structures created by branches with slashes (e.g., `feat/feature-name`)
  - Updated worktree removal to use full paths instead of branch names, ensuring Git can properly locate worktrees in nested directories
  - Parent directories of slash-named branches are no longer incorrectly identified as orphaned and removed
  - Resolves the issue where worktrees were repeatedly created and their parent directories removed in a cycle

## 0.4.0

### Minor Changes

- 8e9ad44: Add config file support for managing multiple repositories
  - Added support for JavaScript configuration files to manage multiple repositories with different settings
  - New CLI options: `--config` to specify config file, `--filter` to select specific repositories, and `--list` to show configured repositories
  - Interactive mode now prompts users to save their configuration to a file for future use
  - When specifying a non-existent config file, users are prompted to create one through interactive setup
  - Config files support environment variables, dynamic paths, and can use relative paths
  - Added comprehensive validation for config files with helpful error messages
  - Maintains full backward compatibility - existing single-repository CLI usage continues to work

  Example config file:

  ```javascript
  module.exports = {
    defaults: {
      cronSchedule: "0 * * * *",
      runOnce: false,
    },
    repositories: [
      {
        name: "my-project",
        repoUrl: "https://github.com/user/repo.git",
        repoPath: "./repos/my-project",
        worktreeDir: "./worktrees/my-project",
      },
    ],
  };
  ```

### Patch Changes

- 8e9ad44: Fix worktree sync failing on restart due to orphaned directories
  - Changed worktree detection to use Git's actual worktree list (`git worktree list`) instead of filesystem directories
  - Added automatic cleanup of orphaned directories that exist on disk but aren't registered Git worktrees
  - Fixed the error "fatal: '/path/to/worktree' already exists" that occurred when restarting after directories were left behind
  - Added comprehensive tests for edge cases including orphaned directory handling

  This ensures the tool works correctly even after system restarts or when directories exist without corresponding Git worktree metadata.

## 0.3.1

### Patch Changes

- 58e9cf1: Fix error when the current branch in base repository conflicts with worktree creation

  Previously, sync-worktrees would fail with a "fatal: 'branch' is already checked out" error when attempting to create a worktree for a branch that was currently checked out in the base repository. This fix now detects the current branch and skips creating a worktree for it, preventing the error while still creating worktrees for all other remote branches.

## 0.3.0

### Minor Changes

- 3d62289: Display CLI command for future reference

  When running sync-worktrees, the tool now displays the exact CLI command that can be used to replicate the current execution. This is shown after configuration is determined (both in interactive and non-interactive modes) and helps users understand how to run the tool directly from the command line with the same parameters.

  The command is displayed in the format:

  ```
  📋 CLI Command (for future reference):
     sync-worktrees --repoPath "/path/to/repo" --worktreeDir "/path/to/worktrees" --runOnce
  ```

- 007d71f: Add initial sync when running in scheduled mode

  When running sync-worktrees in scheduled mode (without --runOnce flag), the tool now performs an initial sync immediately upon startup before waiting for the first scheduled run. This ensures worktrees are synchronized right away instead of waiting for the next cron trigger.

## 0.2.0

### Minor Changes

- 09173a5: Added interactive mode for easier configuration
  - When run without arguments, the tool now launches an interactive setup wizard
  - Prompts users for all required configuration values:
    - Repository path (supports relative paths, automatically converted to absolute)
    - Repository URL (only prompted if the repository doesn't exist)
    - Worktree directory (supports relative paths)
    - Run mode (once or scheduled with cron)
    - Cron schedule (if scheduled mode is selected)
  - Shows a configuration summary before proceeding
  - Makes the tool more user-friendly for first-time users
  - Existing command-line argument usage remains unchanged

## 0.1.1

### Patch Changes

- 941d379: Improved worktree cleanup logic - now checks for unpushed commits before removal to prevent data loss
