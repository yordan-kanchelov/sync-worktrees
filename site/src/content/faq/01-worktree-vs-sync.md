---
question: "What's the difference between git worktree and sync-worktrees?"
order: 1
---

`git worktree` is the underlying Git primitive: a single command that adds one extra working directory backed by a shared `.git` database (it works with any repo, bare or not). sync-worktrees is a workspace orchestrator built on top of it — in worktree mode it sets up a bare repo, creates a directory for every selected remote branch automatically, prunes them when branches are deleted upstream, and keeps the whole thing fresh on a cron schedule. It also ships an interactive TUI and an MCP server so AI agents can navigate and operate the workspace.
