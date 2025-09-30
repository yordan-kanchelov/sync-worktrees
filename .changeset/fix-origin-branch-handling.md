---
"sync-worktrees": patch
---

Fix error when "origin" appears as a branch name causing sync failures. Added early prune at sync start to clean stale worktree registrations, filtered invalid branch names like "origin" from remote branch lists, and improved error handling for "already registered worktree" errors with automatic retry after pruning.