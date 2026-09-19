---
question: "Why use this instead of cloning each branch separately?"
order: 2
---

Cloning duplicates the whole Git history for every branch, and refreshing each clone is a separate `git pull`. Worktrees share one `.git` database, so history is stored once per repository entry. Each branch still costs a working tree, though: 200 live branches with a 300 MB checkout is 60 GB. That is what `branchMaxAge`, `branchInclude`/`branchExclude` and sparse checkout are for, and the TUI's status bar shows the total. sync-worktrees automates the bookkeeping you'd otherwise do by hand: creating worktrees for new remote branches, clearing away the ones whose branch is gone, and handling force-pushes without overwriting your commits.
