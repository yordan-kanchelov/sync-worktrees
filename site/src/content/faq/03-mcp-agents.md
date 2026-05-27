---
question: "How does the MCP server help AI coding agents?"
order: 3
---

The bundled `sync-worktrees-mcp` binary speaks the Model Context Protocol over stdio. AI agents (Claude Code, Cursor, Windsurf, Claude Desktop, VS Code, Codex, Cline, opencode, Warp, Gemini CLI) can call tools like `detect_context`, `list_worktrees`, `create_worktree`, `sync`, and `update_worktree` directly. In a single `detect_context` call with `includeAllWorktrees: true`, an agent working in one repo discovers every sibling repo and worktree you have configured — so "go look in the other repo" actually works without manual re-orientation.
