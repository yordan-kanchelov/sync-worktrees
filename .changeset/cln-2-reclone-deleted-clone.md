---
"sync-worktrees": patch
---

Clone mode: a long-running process (daemon, TUI, MCP server) now re-clones a clone whose directory or `.git` was removed out-of-band on the next sync, instead of failing or skipping it on every tick until restart.
