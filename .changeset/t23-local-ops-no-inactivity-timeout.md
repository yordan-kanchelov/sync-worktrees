---
"sync-worktrees": patch
---

`fetchTimeoutMs` now only applies to git commands that talk to the remote (fetch, push, ls-remote, `remote set-head`); local commands such as `worktree add`, the fast-forward merge, `checkout` and `status` no longer get killed after five silent minutes, so worktree creation in a large repository can finish.
