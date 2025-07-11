---
"sync-worktrees": patch
---

Fix: Filter out origin/HEAD from branch synchronization

Previously, the tool would attempt to create a worktree for the special `origin/HEAD` reference, which would fail with the error "'HEAD' is not a valid branch name". This fix ensures that:

- `origin/HEAD` is filtered out when listing remote branches
- No worktree creation is attempted for HEAD references
- The tool can be run multiple times without errors
- Any orphaned HEAD directories are cleaned up automatically

This resolves issues when syncing repositories that have `origin/HEAD` pointing to their default branch.