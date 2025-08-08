---
"sync-worktrees": patch
---

Improve core sync robustness and add targeted tests:

- Fix branch-by-branch fetch to update remote refs (refs/remotes/origin/*) instead of local branches; respect LFS skip.
- Resolve actual gitdir in worktrees for operation-in-progress detection (handles .git file case).
- Fallback to copy+remove when moving diverged worktrees across devices (EXDEV).
- Ensure parent directories exist before creating nested worktrees.
- Skip updating worktrees with active operations (merge/rebase/etc.).
- Always retain default branch even when branchMaxAge filtering is applied.

Tests added:

- fetchBranch remote ref behavior and LFS env usage.
- hasOperationInProgress via .git file gitdir resolution.
- getRemoteCommit uses bare repo for stability during divergence.
- Diverged move EXDEV fallback path (cp+rm).
- Skip updates during active operations.
- Default branch retention under branchMaxAge.

