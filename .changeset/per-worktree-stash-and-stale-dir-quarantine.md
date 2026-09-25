---
"sync-worktrees": patch
---

Stashes are now attributed to the worktree they were made in. git keeps one stash list for every worktree of a repository, so a single stash anywhere used to make every worktree report "stashed changes": no worktree could be pruned, every diverged replace was skipped, and MCP labelled every worktree dirty. A stash now counts only for the worktree whose branch it was made on (a detached-HEAD stash counts where its base commit is in the worktree's history).

With trash disabled, a stale directory at a managed worktree path that has no `.git` is no longer deleted outright: it is quarantined under a sibling `.removed/` folder like one that has a `.git`. Only an empty directory is removed.
