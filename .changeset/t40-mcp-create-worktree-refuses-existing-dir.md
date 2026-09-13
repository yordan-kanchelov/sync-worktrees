---
"sync-worktrees": patch
---

The MCP `create_worktree` tool now errors with code `TARGET_EXISTS` when its target directory already exists on disk but is not a registered worktree, instead of silently moving that directory to trash (or deleting it when trash is disabled).
