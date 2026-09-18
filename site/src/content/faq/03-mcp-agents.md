---
question: "Is there an MCP server?"
order: 3
---

Yes, optional. The folders on disk are ordinary directories, so `cd`, your editor, and a shell already work. The bundled `sync-worktrees-mcp` binary is extra: nine tools over MCP (stdio) — `detect_context`, `list_worktrees`, `get_worktree_status`, `create_worktree`, `update_worktree`, `sync`, `initialize`, `load_config`, `set_current_repository` — for clients that speak it. No tool deletes, trashes or restores anything directly: the only removal path is `sync`'s own safety-gated prune (into `.trash/` by default), and `sync` is flagged destructive so clients can prompt. Setup per client, what the server sees from where it is launched, every tool, safety and a parallel-agents recipe: [docs/mcp.md](https://github.com/yordan-kanchelov/sync-worktrees/blob/main/docs/mcp.md). Skip it if you don't use an MCP client.
