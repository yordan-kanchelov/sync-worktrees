---
"sync-worktrees": patch
---

Per-worktree sync metadata no longer records the unused `createdFrom` and `syncHistory` fields; existing metadata files that still contain them keep working unchanged.
