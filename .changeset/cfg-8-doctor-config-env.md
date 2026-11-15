---
"sync-worktrees": patch
---

`doctor` now resolves its config the same way as the other commands: when `SYNC_WORKTREES_CONFIG` points to a missing file it names the variable instead of suggesting `init --config` for that path. The MCP server's config walk-up now also stops at your home directory, like the CLI's.
