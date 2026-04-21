---
"sync-worktrees": major
---

Breaking changes in this release:

**MCP server** — sync-worktrees now ships a Model Context Protocol server as a separate binary `sync-worktrees-mcp`. MCP-compatible clients (Claude Code, Claude Desktop, Cursor, Windsurf, etc.) can initialize repositories, list/create/remove/update worktrees, run syncs, load configuration files, detect repository context, and inspect worktree status directly. See the README for setup.

**Drop Windows support** — the platform was never exercised in CI and hooks already refused to run there because cmd.exe shell quoting is unsafe. `package.json` now declares `os: ["darwin", "linux"]` so `npm install` warns Windows users. Removes `win32` branches from the terminal launcher, hook execution guard, case-insensitive FS check, and worktree list CRLF stripping.
