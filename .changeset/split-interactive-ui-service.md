---
"sync-worktrees": patch
---

Internal: the interactive UI service is split into a sync-cycle scheduler, a terminal/editor launcher and a repository-operations layer that the TUI now goes through for branch, worktree and cleanup actions. No change in behaviour.
