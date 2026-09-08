---
"sync-worktrees": patch
---

Worktree mode now recovers from a `bareRepoDir` left without a HEAD by an interrupted initialization: it is removed and cloned again instead of failing every later run with git's "destination path already exists and is not an empty directory". Only a directory sync-worktrees verified and claimed for its own clone can be removed this way; a destination that already holds something else, or that cannot be inspected, is never touched and is named in an actionable error.
