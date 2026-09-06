---
"sync-worktrees": patch
---

Worktree mode no longer creates a worktree from the frozen `refs/heads/*` copy that `git clone --bare` leaves behind for every remote branch (those copies were never fetched into again, so a worktree added months later checked out the clone-time tip, was reported as "created with tracking", and was then reset or moved aside as diverged on the next sync). A fresh bare clone now drops the copies of all but the default branch, and when a local branch ref with no worktree is only behind `origin/<branch>` the new worktree is fast-forwarded to the remote tip as soon as it is created; a local ref with commits not on `origin/<branch>` keeps its tip, the log says why, and the sync records a `local_only_commits` skip for that branch next to its "created" action.
