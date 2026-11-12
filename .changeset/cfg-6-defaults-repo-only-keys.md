---
"sync-worktrees": patch
---

`bareRepoDir`, `repoUrl` and `worktreeDir` under `defaults` were accepted silently but never applied, and a stray `defaults.bareRepoDir` rejected clone-mode repositories as if it were inherited. They are now reported with the usual "Unknown config key … in defaults is ignored" warning and no longer affect clone-mode validation.
