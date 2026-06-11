---
"sync-worktrees": minor
---

Fail-closed worktree removal pipeline.

Worktree removal previously had paths where an error or ambiguous probe result could read as "safe to remove". Every check in the removal path now follows one rule: cannot verify → cannot remove.

- **Status probes fail closed:** a filesystem error (EMFILE/EINTR/EACCES) while checking the worktree path or operation files (`MERGE_HEAD`, rebase state, …) now blocks removal instead of reporting a clean state. Only a genuine `ENOENT` counts as "directory gone".
- **Unpushed detection checks both conditions:** removal requires `rev-list <branch> --not --remotes` = 0 **and** (when sync metadata exists) `rev-list <lastSyncCommit>..HEAD` = 0. Previously the metadata path silently replaced the any-remote check. Note: a worktree where you ever committed after the last sync stays un-prunable until removed manually — deliberate conservatism.
- **Detached HEAD is never auto-removed:** it may sit on commits unreachable from any ref.
- **Non-forced `git worktree remove` by default:** git's own refusal to delete a dirty worktree is kept as the last line of defense and surfaces as a skip, not an error. `--force` is reserved for the diverged-replacement flow (directory already preserved under `.diverged/`).
- **Orphan-directory cleanup can no longer destroy a live checkout:** a directory containing a `.git` is quarantined to `<worktreeDir>/.removed/<timestamp>-<name>/` (never auto-emptied) instead of deleted; an unverifiable probe skips the directory. The same guard applies when `addWorktree` clears a stale target directory.
- **Append-only removal audit log:** every prune removal, orphan deletion/quarantine, and diverged replacement writes a JSONL record (timestamp, path, branch, status snapshot, code path) to `<configDir>/.sync-worktrees-state/<name>-<hash>-removals.jsonl` (or `$XDG_STATE_HOME`/`~/.cache/sync-worktrees/removals/` without a config file). For destructive automatic removals the record is written *before* deletion; if it cannot be written, the removal is skipped.
