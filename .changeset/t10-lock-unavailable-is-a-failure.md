---
"sync-worktrees": patch
---

A repository lock that cannot be prepared or taken (unwritable or missing state directory, `XDG_STATE_HOME` pointing at a file, read-only filesystem, ENOSPC) is now reported as a failure that names the path and errno — `--runOnce` exits 1 and its summary counts the repo as "lock unavailable", the TUI logs an error, and the MCP tools return `LOCK_UNAVAILABLE` — instead of a skip claiming another process holds the lock.
