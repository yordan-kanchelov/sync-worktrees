---
"sync-worktrees": patch
---

A `worktreeDir` or `bareRepoDir` reached through a symlink (including every path under `/tmp` on macOS) failed the first sync with "is not registered with the bare repository" and could move a live worktree aside as an orphaned directory. Worktree paths are now compared after resolving symlinks, so such setups sync normally.
