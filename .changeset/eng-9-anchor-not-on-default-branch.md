---
"sync-worktrees": patch
---

A default-branch worktree left on a detached HEAD or another branch was silently adopted, never updated, and could even be pruned, while the sync reported a clean run. The sync now leaves it alone, warns, and records a `default_branch_detached` or `default_branch_mismatch` skip.
