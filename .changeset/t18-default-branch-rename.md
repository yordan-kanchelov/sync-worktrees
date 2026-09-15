---
"sync-worktrees": patch
---

Worktree mode now follows a default branch rename on the remote (for example `main` → `trunk` with `main` deleted). The detected default was frozen to `refs/remotes/origin/HEAD`, which `fetch --prune` never updates: the old default stayed a forced update candidate whose upstream was gone, so every sync failed with `diverged_recovery_failed`, its worktree was never pruned, and the new default was created as an ordinary hashed directory. The default is now re-resolved (`git remote set-head origin -a`) whenever `origin/<default>` is gone — at initialization and after each fetch — with a "Default branch changed from X to Y" log line; the new default's worktree is created (or an existing one for that branch adopted) and becomes the worktree fetches run from before the old default's worktree goes through the normal prune checks.
