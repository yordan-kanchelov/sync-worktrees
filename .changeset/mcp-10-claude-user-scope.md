---
"sync-worktrees": patch
---

`sync-worktrees init` registered the MCP server with Claude Code at its default per-directory scope, so it was missing in other worktrees. It now registers with `--scope user` (and the manual fallback hint says so); Codex registration is unchanged.
