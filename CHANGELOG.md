# sync-worktrees

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
