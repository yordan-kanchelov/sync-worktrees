# sync-worktrees

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
