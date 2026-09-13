---
"sync-worktrees": patch
---

A managed worktree left on a detached HEAD (after `git checkout <sha>` inside it) is now reported as a skipped worktree instead of being logged and counted as a freshly created one on every sync.
