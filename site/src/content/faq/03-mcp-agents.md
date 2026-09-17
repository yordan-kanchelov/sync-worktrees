---
question: "Is there an MCP server?"
order: 3
---

Yes, optional. The folders on disk are ordinary directories, so `cd`, your editor, and a shell already work. The bundled `sync-worktrees-mcp` binary is extra: it exposes `detect_context`, `list_worktrees`, `create_worktree`, and `sync` over MCP (stdio) for clients that speak it. Skip it if you don't use one.
