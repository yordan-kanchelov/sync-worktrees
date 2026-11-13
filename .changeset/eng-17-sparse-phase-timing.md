---
"sync-worktrees": patch
---

The `--debug` timing table in worktree mode now times the sparse-checkout reconcile as its own "Phase 5: Sparse" row instead of leaving it out, and no longer shows an empty "Phase 5: Cleanup" row that measured nothing.
