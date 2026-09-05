---
"sync-worktrees": patch
---

The MCP `sync` and `initialize` tools now stay unavailable for auto-detected (unconfigured) repositories even after `create_worktree` or `update_worktree` has run, and their reason says whether no config is loaded or the loaded config simply does not list the repository.
