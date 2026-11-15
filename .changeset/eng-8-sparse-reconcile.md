---
"sync-worktrees": patch
---

Sparse-checkout reconcile now applies a `sparseCheckout.mode` change to existing worktrees, no longer treats widening a directory to its parent as narrowing, and stops re-applying cone directories whose names git prints quoted (such as ones containing a backslash) on every sync. A cone-mode `include: ["."]`, which only ever selected root files, is now rejected at config load.
