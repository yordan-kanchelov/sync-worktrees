---
"sync-worktrees": patch
---

A long-lived process (cron daemon, TUI, MCP server) now recovers when the default branch's worktree is deleted out-of-band: every sync re-checks that directory and rebuilds it before fetching, instead of failing forever with `spawn git ENOENT`, and a fetch that does hit a deleted working directory now names it.
