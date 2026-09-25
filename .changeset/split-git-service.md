---
"sync-worktrees": patch
---

Internal refactor: the worktree-mode git layer is split into focused services (worktree creation, worktree registry, branch refs, bare repository, LFS verification) behind the existing `GitService`. No behaviour change.
