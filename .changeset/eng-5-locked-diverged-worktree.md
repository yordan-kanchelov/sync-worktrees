---
"sync-worktrees": patch
---

A locked worktree whose branch diverged with local changes is now left in place and reported as a `worktree_locked` skip (also in `sync --dry-run`). Previously it was moved to `.diverged/` leaving a dangling locked registration (trash off), or failed every sync with `diverged_recovery_failed` (trash on).
