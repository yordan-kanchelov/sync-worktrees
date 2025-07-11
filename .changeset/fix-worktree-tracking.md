---
"sync-worktrees": patch
---

Fix worktrees tracking and creation

- Added fetch before creating main worktree to ensure remote branches exist
- Better error handling for cases where worktree directories already exist
