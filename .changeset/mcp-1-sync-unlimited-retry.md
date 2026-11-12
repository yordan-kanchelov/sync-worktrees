---
"sync-worktrees": patch
---

MCP `sync` no longer hangs forever (holding the repository lock) when the remote is unreachable and `retry.maxAttempts` is `"unlimited"`: the MCP server caps it at 3 attempts, stops retrying when the request is cancelled, and exits when the client closes stdin.
