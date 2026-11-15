---
"sync-worktrees": patch
---

The MCP server never noticed when a loaded config file was edited, so a long-lived session silently kept the old settings. `detect_context` now adds a `CONFIG_CHANGED` note once the file's contents change, telling the agent to call `load_config`.
