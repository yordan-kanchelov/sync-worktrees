---
"sync-worktrees": minor
---

Add automatic updates for existing worktrees

- New feature: Automatically update worktrees that are behind their upstream branches during sync
- Updates are performed using fast-forward merge only (safe, no merge commits)
- Only clean worktrees (no local changes) are updated
- Feature is enabled by default but can be disabled via:
  - CLI flag: `--no-update-existing`
  - Config option: `updateExistingWorktrees: false`
- Improved error handling to skip worktrees with missing directories
- Suppressed test environment warnings for cleaner test output