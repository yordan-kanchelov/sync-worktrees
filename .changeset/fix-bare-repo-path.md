---
"sync-worktrees": patch
---

Fix bare repository path resolution to prevent deletion during cleanup

When using the current directory as the worktree directory, the bare repository
was being created with a relative path that would then be incorrectly identified
as an orphaned directory and deleted during cleanup. This fix ensures the bare
repository path is always resolved to an absolute path.