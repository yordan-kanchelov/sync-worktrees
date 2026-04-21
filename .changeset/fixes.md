---
"sync-worktrees": patch
---

Fixes and hardening:

- Fix branch creation failing on a fresh start: `GitService.initialize()` now always fetches remote refs instead of only fetching during initial clone.
- Fix path traversal vulnerability in diverged directory deletion: validate that the resolved path stays inside `.diverged` before calling `fs.rm`.
- Fix destructive initialization behavior: revert `GitService.initialize()` to graceful "already exists" error handling instead of preemptively deleting directories with `fs.rm`.
- Skip worktree removal on status check failure instead of risking dirty worktree removal.
- Rollback worktree on metadata creation failure.
- LFS skip via service method instead of mutating `process.env`.
- Remove `hasStashedChanges` from worktree removal safety gate: stashes live in the repository, not the worktree directory.
- Add early return in `getFullWorktreeStatus()` for non-existent worktree paths, preventing cascading status check failures.
- Metadata service hardening: atomic writes, branch name sanitization in paths, auto-create metadata on update when missing.
- Path resolution security: use `path.resolve()` to prevent path traversal edge cases.
- Config loader: resolve `filesToCopyOnBranchCreate` paths relative to config dir, escape special characters in wildcard filters.
- Keyboard navigation correctly skips the visual separator between worktrees and diverged entries in status view.
