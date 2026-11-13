---
"sync-worktrees": patch
---

`sync --dry-run` in clone mode planned a clone into a non-empty directory that is not a repository, and planned a sync for a clone left unfinished by an earlier failed clone, though the real sync refuses both. The dry run now fails for that repository with the same error the sync reports.
