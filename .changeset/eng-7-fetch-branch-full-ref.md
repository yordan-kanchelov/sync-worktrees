---
"sync-worktrees": patch
---

Updating a single branch (MCP `update_worktree`) fetched a same-named tag instead of the branch when origin had both, so the worktree never updated. It now fetches the branch by its full ref.
