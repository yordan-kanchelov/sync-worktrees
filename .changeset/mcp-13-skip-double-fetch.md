---
"sync-worktrees": patch
---

The MCP `create_worktree` tool no longer fetches from origin a second time when it had to initialise the repository with a fresh clone in the same call, and lists the registered worktrees once instead of twice.
