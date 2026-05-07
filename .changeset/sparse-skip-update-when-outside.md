---
"sync-worktrees": minor
---

feat(sparse): skip fast-forward updates when upstream diff is outside sparse cone

Sparse-checkout users in cone mode now avoid pointless `git merge --ff-only` work when the incoming commits only touch files outside the materialized include set — the working tree wouldn't have changed anyway. Saves LFS smudge, post-checkout hooks, and disk churn in monorepos that fan out one upstream into multiple sparse slices.

Changes:
- `SparseCheckoutConfig` gains `skipUpdateWhenOutsideSparse?: boolean` (default `true`). Set to `false` to keep HEAD strictly tracking remote even when no sparse files change.
- New `SparseCheckoutService.pathsTouchSparse()` mirrors git's cone-mode materialization rules, including direct files in every ancestor of an included directory (e.g. include `tools/build` keeps `tools/foo.txt` checked out, so a change to that file still triggers an update).
- New `GitService.getChangedPathsInRange()` runs `git -c core.quotePath=false diff --name-only --no-renames` between two refs. Returns `null` on git failure so the caller forces a safe update rather than silently skipping a behind worktree.
- Wired into Phase 4a of `WorktreeSyncService.updateExistingWorktrees()` after the existing `isWorktreeBehind` check.

No-cone mode falls through to the existing update path; gitignore-style pattern matching with negation is intentionally out of scope here.

Trade-off: when an update is skipped, the worktree's local HEAD lags the remote tip. `git status` inside that worktree will show "behind by N commits" until upstream advances into the sparse area or `skipUpdateWhenOutsideSparse: false` is set.
