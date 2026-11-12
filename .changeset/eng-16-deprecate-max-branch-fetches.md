---
"sync-worktrees": patch
---

`parallelism.maxBranchFetches` only bounded an LFS branch-by-branch fetch fallback that could never run. That fallback is removed; the key is still accepted but now logs a one-time deprecation warning saying it has no effect.
