---
"sync-worktrees": patch
---

fix(git): skip upstream tracking when remote branch missing in `addWorktree`

`GitService.addWorktree` previously always attempted upstream tracking against `origin/<branch>`, even when the remote ref didn't exist (e.g. MCP `create_worktree` with `push: false` for a brand-new branch). Tracking failed and the code fell back to a non-tracking worktree add with a noisy warning.

Now `addWorktree` probes both refs explicitly via `git show-ref --verify` and branches on `(localExists, remoteExists)`:

- both exist → `worktree add` + `--set-upstream-to`
- local-only → `worktree add` without upstream (push later via `pushBranch -u` to set tracking)
- remote-only → `worktree add --track -b`
- neither → throws a clear `WorktreeError`

The `branchName.includes("/")` shortcut and the prune-retry path were updated to use the same matrix. No status/metadata service changes needed — `rev-list --not --remotes` already handles no-upstream worktrees correctly.
