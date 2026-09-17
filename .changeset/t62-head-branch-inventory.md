---
"sync-worktrees": patch
---

Remote branches whose names end in `/HEAD` (such as `feature/HEAD`) are now kept in the sync inventory — only the real `origin/HEAD` symref is skipped — so their worktrees are created instead of being pruned as stale, and branch listings no longer lose or rename branches when a local branch named `origin/<name>` exists.
