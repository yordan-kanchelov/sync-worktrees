---
"sync-worktrees": patch
---

Fix worktrees to properly track remote branches

Worktrees created by sync-worktrees now have proper upstream tracking configured, allowing `git pull` to work without specifying the remote and branch. This was the expected behavior and improves the Git workflow experience when working with synced worktrees.

- Worktrees are now created with `--track` flag to automatically set up tracking
- If a local branch already exists, upstream tracking is configured after worktree creation
- Fallback to non-tracking worktree creation if remote branch doesn't exist yet
