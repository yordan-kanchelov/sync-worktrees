---
"sync-worktrees": patch
---

A sync attempt that is retried no longer drops worktrees it had already created, removed, updated or preserved before the retryable error; the final outcome now reports those changes, and only skips, no-ops and failures from the failed attempt are discarded.
