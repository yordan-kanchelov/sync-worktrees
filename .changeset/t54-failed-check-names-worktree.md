---
"sync-worktrees": patch
---

A worktree whose check fails during a sync is now named in both the log and the outcome. Both phases' `Error checking worktree ...` lines now carry the worktree path next to the branch, and the prune phase's `prune_status_check_failed` skip records the path alongside the branch it already had — so on a daemon watching hundreds of worktrees, a corrupt index or an unmounted volume points at the directory to look at instead of leaving every tick's `fatal:` unattributable.
