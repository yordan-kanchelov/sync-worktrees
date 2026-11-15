---
"sync-worktrees": patch
---

MCP `get_worktree_status` no longer reports a removed worktree as clean and removable from a stale session snapshot, and answers detached worktrees the same every time; `list_worktrees` now marks `isCurrent` from the server's launch directory, so it no longer flips after other tool calls.
