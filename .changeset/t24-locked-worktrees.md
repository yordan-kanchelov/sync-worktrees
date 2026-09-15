---
"sync-worktrees": patch
---

Worktrees locked with `git worktree lock` are now skipped during pruning (with the lock reason in the log) instead of being size-scanned and moved in and out of `.trash/` on every tick, and git's refusals to remove a locked worktree or one containing initialized submodules are recorded as skips rather than failures that set a non-zero exit code.
