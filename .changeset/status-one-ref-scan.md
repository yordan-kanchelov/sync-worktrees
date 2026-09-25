---
"sync-worktrees": patch
---

Worktree status checks spawn fewer git processes: the checked-out branch now comes from `git status`, and branches, remote-tracking refs and upstreams are read once per repository per pass (prune checks, the TUI status view, `list_worktrees`, `detect_context`) instead of running `git branch`, `git branch -r` and `rev-parse @{upstream}` for every worktree. `upstreamGone` (the `stale` label) no longer fires for a branch that tracks an existing local branch, and now does fire when the upstream has been pruned. During a rebase or bisect, stashes made on the branch are no longer missed.
