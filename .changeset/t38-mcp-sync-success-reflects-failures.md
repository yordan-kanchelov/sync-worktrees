---
"sync-worktrees": patch
---

The MCP `sync` tool now reports `success: false` whenever the run recorded a failed action (matching the CLI's `--runOnce` exit code 1) and adds top-level `failed` and `failures` fields so agents can see what went wrong without digging through `outcome.actions`.
