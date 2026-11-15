---
"sync-worktrees": patch
---

MCP: `load_config` now drops an auto-detected entry for a repository the config also lists (no duplicate entry or second service), `localReady` is false for an empty bare directory, and `initialize` returns `success: false` with `skips` when it refuses to adopt an existing clone (wrong branch or origin) instead of reporting success.
