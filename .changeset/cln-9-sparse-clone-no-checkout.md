---
"sync-worktrees": patch
---

Clone mode with `sparseCheckout` no longer checks out (and downloads LFS content for) the whole tree before narrowing it: the initial clone now runs with `--no-checkout` and only the configured cone is checked out.
