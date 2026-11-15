---
"sync-worktrees": patch
---

`sync-worktrees trash` no longer prints an "Unhandled error" stack for a repository that has never been synced (a listing now says "No trash entries.", other actions report that the repository has not been synced yet), and `trash restore` now reports a branch git refuses to create as a one-line trash error with the entry left intact.
