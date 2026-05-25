---
title: Landing-page hero and section copy
---

# Keep every branch checked out. For you and your AI agents.

sync-worktrees materializes your entire branch and repo layout on disk, keeps it in sync with the remote, and exposes it to any MCP-compatible AI tool — no stashing, no re-cloning, no re-explaining your codebase.

## The problem

Without sync-worktrees: stash half-finished work, hunt for where you cloned a sibling repo, switch branches in five repos because one feature spans all of them, re-explain to an AI assistant which directory holds which branch.

With sync-worktrees: every branch is a directory. Switching branches becomes `cd`. Searching across repos becomes `grep -r`. AI agents see the same workspace shape you do, so "look in the other repo" actually works.

## Features

- **Worktree mode** — one folder per remote branch, one shared `.git` database underneath. Disk usage scales with working-tree size, not branch count.
- **Clone mode** — single-branch checkout at a fixed path. For dependency siblings, single-purpose dev environments, or anywhere one checkout is enough.
- **MCP server** — first-class AI agent integration over stdio. `detect_context`, `list_worktrees`, `create_worktree`, `sync`, `update_worktree`, and more.
- **Interactive TUI** — Ink-based terminal UI with wizards for opening worktrees in your editor or terminal, creating branches, and inspecting multi-repo status. Live log streaming.
- **Smart filtering** — glob include/exclude patterns, age-based filtering, sparse checkout for monorepos, per-repo overrides.
- **Safety by default** — force-push detection with `.diverged/` preservation, unpushed-commit protection, dirty-tree refusal, in-progress-operation detection, and safe pruning.

## Quick start

```
npm install -g sync-worktrees
cd ~/projects/my-sync-dir
sync-worktrees init      # interactive wizard writes sync-worktrees.config.js
sync-worktrees           # launches the TUI and starts syncing on schedule
```

For CI or scripted runs, add `--runOnce`.

## AI agents

sync-worktrees ships a Model Context Protocol server that any MCP client can speak to. The fastest setup for Claude Code:

```
claude mcp add sync-worktrees -- npx -y -p sync-worktrees sync-worktrees-mcp
```

For other tools (Cursor, Windsurf, Codex, Cline, opencode, Warp, Gemini CLI, VS Code, Claude Desktop), see the AI agents section for one-step setup snippets per client.
