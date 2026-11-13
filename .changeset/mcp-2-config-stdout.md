---
"sync-worktrees": patch
---

The MCP server no longer lets output a config file prints (for example a `console.log` from dotenv) corrupt its JSON-RPC stream on stdout: that output, on first load and on every `load_config` reload, now goes to stderr.
