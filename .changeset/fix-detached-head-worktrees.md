---
"sync-worktrees": patch
---

fix: handle detached HEAD worktrees and skip metadata for main worktree

- Add detached HEAD detection to prevent ambiguous argument errors
- Skip metadata operations for the main worktree (not in worktrees dir)
- Update worktree parsing to exclude detached HEAD worktrees
- Add comprehensive tests for all new edge cases

This fixes the "ambiguous argument" error for worktrees in detached HEAD state
and removes the unnecessary "No metadata found for worktree main" warning.