---
"sync-worktrees": patch
---

Clone mode with `branch` unset now keeps syncing the default branch recorded when the clone was made. Previously every new process asked the remote again, so a remote whose default moved (say from `main` to `trunk`) left the existing clone skipped with a branch mismatch.
