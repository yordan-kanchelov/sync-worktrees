---
"sync-worktrees": patch
---

`branchMaxAge: "0d"` (or a duration so large the cutoff date is invalid) passed validation and planned the removal of every non-default worktree. Such values are now rejected as config errors.
