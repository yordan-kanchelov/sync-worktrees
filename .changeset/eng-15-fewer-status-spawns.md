---
"sync-worktrees": patch
---

Status checks spawned redundant git processes: `git stash list` once per worktree, the same `rev-list` twice in the usual prune case, and `git branch -v -a` just to read the current branch. A status pass now lists stashes once per repository, reuses the matching `rev-list`, and reads the branch with `git symbolic-ref`.
