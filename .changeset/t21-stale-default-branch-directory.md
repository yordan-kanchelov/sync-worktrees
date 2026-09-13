---
"sync-worktrees": patch
---

Worktree mode no longer adopts a pre-existing directory at the default branch's worktree path that is not a registered worktree (for example the checkout left behind after deleting `.bare/` to recover from corruption). Initialization now moves it to `.trash/` (or `.removed/` when trash is disabled) like any other stale worktree directory, recreates the default-branch worktree, and fails with `WORKTREE_NOT_REGISTERED` naming the path if the worktree is still not registered afterwards — instead of pointing every later fetch at a non-repository.
