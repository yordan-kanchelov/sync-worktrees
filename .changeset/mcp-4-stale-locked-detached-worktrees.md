---
"sync-worktrees": patch
---

MCP `list_worktrees` and `detect_context { includeStatus }` no longer report a worktree whose directory is gone as clean and safe to remove, or a locked worktree as safe to remove, and `list_worktrees` now lists detached worktrees (never safe to remove). `update_worktree` on a missing directory now fails with code `WORKTREE_MISSING` instead of a raw `spawn git ENOENT`.
