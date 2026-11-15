---
"sync-worktrees": patch
---

Updating an existing worktree no longer fails on every sync when Git LFS cannot download a file: the fast-forward and the sparse-checkout re-apply now retry once with LFS downloads disabled, as worktree creation already did. A fast-forward that still fails has its half-written files undone, so the worktree is not left dirty and heals once LFS works again.
