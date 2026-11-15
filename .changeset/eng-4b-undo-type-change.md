---
"sync-worktrees": patch
---

Undoing a rejected fast-forward now also restores a tracked file the half-applied checkout replaced with a symlink (or a symlink replaced with a file), instead of leaving the checkout dirty and skipped on every later sync.
