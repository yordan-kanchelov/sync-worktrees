---
'sync-worktrees': patch
---

Fix error when the current branch in base repository conflicts with worktree creation

Previously, sync-worktrees would fail with a "fatal: 'branch' is already checked out" error when attempting to create a worktree for a branch that was currently checked out in the base repository. This fix now detects the current branch and skips creating a worktree for it, preventing the error while still creating worktrees for all other remote branches.