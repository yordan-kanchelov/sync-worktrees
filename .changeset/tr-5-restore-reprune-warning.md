---
"sync-worktrees": patch
---

`trash restore` of a pruned worktree whose remote branch is gone now warns that the next sync will prune it again unless it holds uncommitted or unpushed work. The trash docs now cover that, and the `commits.bundle` backup with its recovery command.
