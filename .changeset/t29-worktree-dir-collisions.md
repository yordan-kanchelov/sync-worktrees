---
"sync-worktrees": patch
---

Config loading now rejects two repository entries that resolve to the same `worktreeDir`, or whose `worktreeDir` overlaps another entry's `bareRepoDir`, naming both entries and the path; previously each sync moved the other repository's checkouts to trash while reporting success. A `worktreeDir` nested inside another entry's `worktreeDir` now logs a warning.
