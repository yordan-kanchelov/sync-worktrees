---
"sync-worktrees": patch
---

`parallelism.maxRepositories` under `defaults` now overrides the top-level value, like every other parallelism field and as the docs describe; previously the top-level value won. A repository-level `maxRepositories`, which never had any effect, now prints a warning, and `init` no longer advertises it as a per-repository option.
