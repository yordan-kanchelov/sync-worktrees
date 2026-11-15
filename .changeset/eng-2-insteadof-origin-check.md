---
"sync-worktrees": patch
---

The origin check compared the URL after git applied `url.<base>.insteadOf` rewrites, so a repository behind such a rule failed (worktree mode) or was skipped (clone mode) on every run after cloning. It now compares the stored `remote.origin.url` against `repoUrl`.
