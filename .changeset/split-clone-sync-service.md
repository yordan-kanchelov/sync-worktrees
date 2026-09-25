---
"sync-worktrees": patch
---

Internal: split the clone-mode sync service into focused modules (clone bootstrap and cleanup, fetch and the shallow-depth ratchet, remote-config convergence and the stale-ref sweep, sparse reconciliation, fast-forward undo, branch operations, phase timing). No behaviour change.
