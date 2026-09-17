---
"sync-worktrees": patch
---

Retry a worktree checkout that fails its Git LFS smudge filter once with LFS downloads disabled, instead of failing that branch on every sync, and delete the local branch git leaves behind when `worktree add` fails.
