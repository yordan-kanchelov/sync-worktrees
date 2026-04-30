---
"sync-worktrees": minor
---

fix(sync): prevent indefinite hang on stalled SSH and concurrent fetches

Fetch operations (`git fetch`, `git clone`) had no timeout. A stalled SSH connection to the remote would leave the underlying `git`/`ssh` child processes sleeping forever; `pLimit` slots were held, `Promise.allSettled` never resolved, and the TUI status stayed on "Syncing..." indefinitely. If the parent process was killed, those child processes survived (reparented to PID 1) and a fresh process happily started overlapping fetches against the same bare repo.

Changes:
- `GitService` now constructs `simple-git` with `timeout: { block: ms }`. Inactivity beyond the window terminates the underlying `git` child via SIGINT (which propagates to its `ssh` transport via git's `cleanup_children_on_signal`).
- New config knobs `fetchTimeoutMs` (default 5 min) and `cloneTimeoutMs` (default 15 min — clone can be silent longer during server-side pack resolution). Set to `0` to disable.
- `WorktreeSyncService.sync()` now acquires a `proper-lockfile` lock on the bare repo's `HEAD` file. Concurrent runs from another process return `{ started: false, reason: "locked" }` and surface as a skipped repo in the orchestrator log instead of stomping on each other.
- `SyncResult` extended with the new `"locked"` skip reason.
