---
"sync-worktrees": major
---

Add MCP (Model Context Protocol) server implementation, exposing sync-worktrees as a set of tools that can be invoked by MCP-compatible clients (Claude Code, Claude Desktop, etc.).

The server is shipped as a separate binary `sync-worktrees-mcp` and provides tools for initializing repositories, listing/creating/removing/updating worktrees, running syncs, loading configuration files, detecting repository context, and inspecting worktree status.
