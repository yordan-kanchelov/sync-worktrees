---
"sync-worktrees": patch
---

The MCP read-only tools `list_worktrees`, `get_worktree_status` and `detect_context { includeStatus }` refreshed and rewrote every worktree's git index, which could take `index.lock` under another agent's commit. They now run their status probes with `GIT_OPTIONAL_LOCKS=0` and leave the index untouched.
