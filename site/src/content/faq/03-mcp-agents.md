---
question: "How does the MCP server help AI coding agents?"
order: 3
---

The bundled `sync-worktrees-mcp` binary exposes its tools over MCP (stdio). `detect_context`, `list_worktrees`, `create_worktree`, and `sync` let an agent discover every configured sibling repo and worktree in one `detect_context` call, so "go look in the other repo" works without manual re-orientation.
