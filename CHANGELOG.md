# sync-worktrees

## 2.2.0

### Minor Changes

- 345a430: Add interactive UI commands and improvements

  ### New UI Commands
  - Press `c` to open the **Branch Creation Wizard** - create and push new branches with validation
  - Press `o` to open the **Editor Wizard** - quickly open your editor in any worktree
  - Arrow keys to scroll through logs in the new **Log Panel**

  ### New Configuration Option
  - `filesToCopyOnBranchCreate` - specify files to automatically copy from the base branch when creating new branches (e.g., `.env.local`, config files)

  ### CLI Changes
  - Add `--sync-on-start` flag for config mode - UI now starts immediately without initial sync by default
  - Use `--sync-on-start` to restore previous behavior (sync on startup)

  ### New Services
  - `FileCopyService` - handles copying configured files to new branches
  - `triggerInitialSync()` public method on `InteractiveUIService`

  ### Internal Improvements
  - Event-based UI communication via `appEvents` utility
  - Enhanced logger with UI output function support
  - Git service additions: `branchExists`, `createBranch`, `pushBranch`

### Patch Changes

- 345a430: Fix false "diverged branch" detection when local is ahead of remote

  Previously, when a local branch had unpushed commits (ahead of remote), the sync would incorrectly treat it as a diverged branch and move the worktree to `.diverged/`. This happened because `canFastForward` returns false when local is ahead of remote.

  Now, when a branch cannot fast-forward, we check if local is simply ahead of remote (has unpushed commits). If so, we skip the worktree with a message instead of treating it as diverged. Truly diverged branches (where local and remote have different commits not in a linear history) are still handled correctly.

## 2.1.0

### Minor Changes

- f4d7d7f: Add improvements to support parallel operations
  - Add total concurrency validation to prevent resource exhaustion. Configs now validate that total concurrent operations (maxRepositories × per-repo limits) don't exceed safe limit of 100.
  - Add exponential backoff with jitter support to prevent thundering herd problem in concurrent Git operations. Configure via `retry.jitterMs` option.

## 2.0.0

### Major Changes

- d7533c3: # Interactive Terminal UI with ink + Vitest Migration

  ## Breaking Changes

  ### Test Framework: Jest → Vitest
  - Migrated all 31 test files to Vitest for native ESM support
  - Enables React component testing with ink-testing-library
  - **Impact**: CI/CD pipelines must update test commands
  - **Migration**: Replace `jest` with `vitest run`, `jest --watch` with `vitest`

  ### Build System: TypeScript Compiler → esbuild
  - Switched to esbuild for ESM bundling with better performance
  - Output is now single bundled file instead of transpiled modules

  ## New Features

  ### Interactive Terminal UI (ink-based)
  - **Real-time sync status display** with live updates showing idle/syncing state
  - **Keyboard controls**:
    - `?` or `h` - Toggle help modal
    - `s` - Trigger manual sync
    - `r` - Reload configuration
    - `q` or `Ctrl+C` - Graceful quit

## 1.8.0

### Minor Changes

- 4958da3: Smart divergence detection - only move worktrees to `.diverged` when you've made local changes

  Enhanced divergence handling to avoid unnecessary `.diverged` moves. Previously, when someone force-pushed a branch (e.g., after a rebase), sync-worktrees would move your worktree to `.diverged` even if you hadn't made any local changes - it was just a stale snapshot of the old remote state.

  **Changes:**
  - Checks if you've made local commits since last sync using metadata
  - If HEAD == lastSyncCommit: Just resets to new upstream (no local changes)
  - If HEAD != lastSyncCommit: Moves to `.diverged` (preserve your work)
  - If metadata is missing: Safely moves to `.diverged` (conservative default)

  **Result:**
  `.diverged` now only contains worktrees with actual user work that needs review, not stale upstream snapshots.

## 1.7.5

### Patch Changes

- 3f91a81: Fix false positive "unpushed commits" warnings for branches with slashes in names

  Fixed a critical bug where branches with slashes in their names (e.g., `fix/test-branch`, `feature/new-feature`) would incorrectly report "unpushed commits" even when they were cleanly synced and merged.

  **Root Cause:**
  - Git stores worktree metadata using the basename of the worktree path (e.g., `.git/worktrees/test-branch/`)
  - sync-worktrees was using the full branch name with slashes (e.g., `.git/worktrees/fix/test-branch/`)
  - This path mismatch caused metadata loading to fail, triggering false positives

  **Changes:**
  - Added path-based metadata methods that correctly derive the worktree directory name from the worktree path
  - All metadata operations now use `path.basename()` to match Git's internal structure
  - Added automatic migration from old incorrect paths to new correct paths
  - Updated all callsites in GitService to use the new path-based methods

  **Migration:**
  Existing worktrees with metadata in the old (incorrect) path will be automatically migrated to the correct path on first load. The old metadata files will be cleaned up automatically.

- 3f91a81: Fix error when "origin" appears as a branch name causing sync failures. Added early prune at sync start to clean stale worktree registrations, filtered invalid branch names like "origin" from remote branch lists, and improved error handling for "already registered worktree" errors with automatic retry after pruning.
- 3f91a81: fix: correctly detect squash-merged branches with deleted upstreams

  Fixed a bug where worktrees for squash-merged branches (where the remote branch was deleted) were incorrectly flagged as having "unpushed commits" even when they had never been touched locally.

  The issue occurred because `hasUpstreamGone()` returned `false` when Git couldn't resolve `@{upstream}` due to the remote branch being deleted. This caused the metadata-based check to be skipped, falling back to `git rev-list --count <branch> --not --remotes`, which incorrectly counted the original (now-squashed) commits as "unpushed".

  The fix checks the branch's upstream configuration when `@{upstream}` resolution fails, and verifies whether the configured remote branch actually exists. This allows the metadata-based check to run, which correctly reports zero unpushed commits for untouched worktrees.

## 1.7.4

### Patch Changes

- 762daf8: Fix error when "origin" appears as a branch name causing sync failures. Added early prune at sync start to clean stale worktree registrations, filtered invalid branch names like "origin" from remote branch lists, and improved error handling for "already registered worktree" errors with automatic retry after pruning.

## 1.7.3

### Patch Changes

- 8218f24: Fix prettier formatting errors and test issues causing pipeline failures

## 1.7.2

### Patch Changes

- 19f4b8b: Improve core sync robustness and add targeted tests:
  - Fix branch-by-branch fetch to update remote refs (refs/remotes/origin/\*) instead of local branches; respect LFS skip.
  - Resolve actual gitdir in worktrees for operation-in-progress detection (handles .git file case).
  - Fallback to copy+remove when moving diverged worktrees across devices (EXDEV).
  - Ensure parent directories exist before creating nested worktrees.
  - Skip updating worktrees with active operations (merge/rebase/etc.).
  - Always retain default branch even when branchMaxAge filtering is applied.

  Tests added:
  - fetchBranch remote ref behavior and LFS env usage.
  - hasOperationInProgress via .git file gitdir resolution.
  - getRemoteCommit uses bare repo for stability during divergence.
  - Diverged move EXDEV fallback path (cp+rm).
  - Skip updates during active operations.
  - Default branch retention under branchMaxAge.

## 1.7.1

### Patch Changes

- 7086452: Fix diverged branch detection and recovery mechanism
  - Improve `canFastForward` detection using merge-base comparison for more reliable divergence detection
  - Add recovery mechanism for fast-forward failures during updates

  This fixes the issue where branches that cannot be fast-forwarded would fail with an error instead of being properly handled as diverged branches.

## 1.7.0

### Minor Changes

- 22d406d: Add smart handling for rebased and force-pushed branches
  - Automatically detect when branches have been rebased or force-pushed
  - Reset branches to upstream when file content is identical (clean rebase)
  - Move branches with diverged content to `.diverged` directory
  - Preserve local changes while keeping worktrees in sync with upstream
  - Add comprehensive test coverage for all edge cases
  - Prevent race conditions with unique diverged names
  - Support branch names with special characters

  This feature helps developers who work with rebased branches by automatically handling the common case where branches are rebased but have identical content, while safely preserving any local changes that differ from upstream.

## 1.6.3

### Patch Changes

- 5479f0b: fix: handle detached HEAD worktrees and skip metadata for main worktree
  - Add detached HEAD detection to prevent ambiguous argument errors
  - Skip metadata operations for the main worktree (not in worktrees dir)
  - Update worktree parsing to exclude detached HEAD worktrees
  - Add comprehensive tests for all new edge cases

  This fixes the "ambiguous argument" error for worktrees in detached HEAD state
  and removes the unnecessary "No metadata found for worktree main" warning.

## 1.6.2

### Patch Changes

- 01be2e9: Fix orphaned directory cleanup in LFS error fallback path
  - Added orphaned directory cleanup when worktree tracking setup fails
  - Prevents directories from being left behind after LFS errors or other failures during retry
  - Ensures consistent cleanup behavior across all error scenarios

## 1.6.1

### Patch Changes

- a03b565: Fix orphaned directory cleanup when worktree creation fails
  - Clean up orphaned directories before creating worktrees to handle cases where previous attempts failed (e.g., due to LFS errors)
  - Check if a directory is already a valid worktree before attempting to create it
  - Prevent "already exists" errors when retrying after failures

## 1.6.0

### Minor Changes

- 242bcdd: Improve warning messages for branches with deleted upstream

  When a branch's upstream is deleted (e.g., after squash merge), sync-worktrees now shows clearer messages explaining why the worktree cannot be automatically removed. The new messages guide users to manually review and clean up if their changes were already integrated.

  **Example:**

  ```
  ⚠️ Cannot automatically remove 'feat/LCR-5982' - upstream branch was deleted.
     Please review manually: cd worktrees/feat/LCR-5982 && git log
     If changes were squash-merged, you can safely remove with: git worktree remove worktrees/feat/LCR-5982
  ```

- 242bcdd: Add sync metadata tracking to accurately detect unpushed commits

  Sync-worktrees now tracks synchronization metadata for each worktree, storing information about the last synced commit. This enables accurate detection of truly unpushed commits when a branch's upstream has been deleted (e.g., after squash merge).

  **Benefits:**
  - Accurately detects new commits made after the upstream was deleted
  - Allows safe cleanup of worktrees whose changes were already integrated via squash merge
  - Prevents false positives where all commits appeared as "unpushed" after upstream deletion

  **Technical details:**
  - Metadata is stored in Git's worktree directory: `.git/worktrees/[worktree-name]/sync-metadata.json`
  - Automatically created when adding worktrees and updated during sync operations
  - Backward compatible - works seamlessly with existing setups

## 1.5.0

### Minor Changes

- 13d10f8: Add automatic updates for existing worktrees
  - New feature: Automatically update worktrees that are behind their upstream branches during sync
  - Updates are performed using fast-forward merge only (safe, no merge commits)
  - Only clean worktrees (no local changes) are updated
  - Feature is enabled by default but can be disabled via:
    - CLI flag: `--no-update-existing`
    - Config option: `updateExistingWorktrees: false`
  - Improved error handling to skip worktrees with missing directories
  - Suppressed test environment warnings for cleaner test output

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
