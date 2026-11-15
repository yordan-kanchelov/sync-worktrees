---
"sync-worktrees": patch
---

The parallelism safety ceiling no longer weighs clone-mode repositories at worktree-only settings such as `maxStatusChecks`, which clone mode never uses, so a config of six clone-mode repositories with `maxRepositories: 6` now loads.
