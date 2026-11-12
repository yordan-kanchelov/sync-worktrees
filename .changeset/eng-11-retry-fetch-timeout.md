---
"sync-worktrees": patch
---

A fetch killed by `fetchTimeoutMs`, and git's "Could not resolve host", "Connection refused" and "Connection timed out" failures, now count as retryable as the docs say; before, they failed the sync on the first attempt.
