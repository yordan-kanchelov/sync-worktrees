---
question: "What's the difference between git worktree and sync-worktrees?"
order: 1
---

`git worktree` is the underlying Git primitive: a single command that adds one extra working directory backed by a shared `.git` database (it works with any repo, bare or not). sync-worktrees is a workspace orchestrator built on top of it. In worktree mode it sets up a bare repo, creates a directory for every selected remote branch automatically, clears them away when branches are deleted upstream, and refreshes the whole set on a cron schedule. It also ships an interactive TUI, and an optional MCP server.

Worktrees share the object database for free, so the bare repo is not a redundant reference store. It is the layout that lets every branch, the default included, be a peer directory instead of one privileged checkout. What sync-worktrees adds is the bookkeeping around `git worktree`, not the worktrees themselves: mirroring the remote, clearing away deleted branches, and fast-forwarding clean trees on a schedule, across many repos from one config. Submodules are the exception: as in plain Git, each worktree keeps its own submodule checkout.
