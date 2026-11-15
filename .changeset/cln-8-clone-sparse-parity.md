---
"sync-worktrees": patch
---

Clone mode now honours `sparseCheckout.skipUpdateWhenOutsideSparse` like worktree mode, and records a sparse-checkout re-apply as an `updated` outcome. A sync that fails after an earlier sparse-checkout failure now also reports the `sync_failed` error instead of only the sparse failure.
