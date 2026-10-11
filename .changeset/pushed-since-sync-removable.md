---
"sync-worktrees": patch
---

A worktree you committed in and pushed from is no longer reported as having unpushed commits forever. Removal also checks commits made since the last sync (`lastSyncCommit..HEAD`), and `lastSyncCommit` only moves when this tool creates or fast-forwards the worktree, so a commit pushed (or a `git pull` made) from inside the worktree kept it un-prunable until removed by hand — previously documented as deliberate conservatism. Those commits are now waived once HEAD is on the branch's own upstream: the upstream ref exists and HEAD is not ahead of it. Commits missing from every remote still block removal, and so do commits that only reached some other remote branch, or a worktree whose upstream is missing, gone or unreadable.
