---
"sync-worktrees": minor
---

Add diverged directory management to the worktree status view. Users can now see, inspect, and delete `.diverged` directories (worktrees preserved when their remote branch was deleted but local changes existed) directly from the interactive UI.

- Display diverged directories in the status view with original branch name, size, and divergence date
- Press `d` on a diverged entry to delete it, with `y/n` confirmation prompt
- Keyboard navigation correctly skips the visual separator between worktrees and diverged entries

Also includes security and safety fixes:

- Fix path traversal vulnerability in diverged directory deletion: validate that the resolved path stays inside `.diverged` before calling `fs.rm`
- Fix destructive initialization behavior: revert `GitService.initialize()` to graceful "already exists" error handling instead of preemptively deleting directories with `fs.rm`
- Remove `hasStashedChanges` from worktree removal safety gate: stashes live in the repository, not the worktree directory, so they should not block removal
- Add early return in `getFullWorktreeStatus()` for non-existent worktree paths, preventing cascading status check failures
