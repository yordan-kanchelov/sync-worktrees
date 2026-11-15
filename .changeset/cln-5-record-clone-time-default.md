---
"sync-worktrees": patch
---

Clone mode with no `branch` configured now records the clone-time default branch itself, so a clone made with a recent git (2.56 no longer writes `origin/HEAD` on a single-branch clone) keeps syncing its branch after the remote's default changes.
