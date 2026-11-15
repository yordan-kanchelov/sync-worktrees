---
"sync-worktrees": patch
---

MCP `create_worktree` no longer fails when origin is unreachable: the fetch is now best-effort, the worktree is created from local refs, and the response carries a warning that branch existence was judged from the last successful fetch.
