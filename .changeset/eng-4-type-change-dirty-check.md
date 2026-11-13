---
"sync-worktrees": patch
---

The dirty check treated a type change (a tracked file replaced by a symlink) and mixed states such as a staged edit later deleted (`MD`) as clean, so such a worktree could be pruned or fast-forwarded over. These now count as uncommitted changes and are named in the skip reason.
