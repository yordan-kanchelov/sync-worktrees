---
question: "What's the difference between git worktree and sync-worktrees?"
order: 1
---

`git worktree` is the underlying Git primitive: a single command that adds one extra working directory backed by a shared `.git` database (it works with any repo, bare or not). sync-worktrees is a workspace orchestrator built on top of it — in worktree mode it sets up a bare repo, creates a directory for every selected remote branch automatically, prunes them when branches are deleted upstream, and keeps the whole thing fresh on a cron schedule. It also ships an interactive TUI and an MCP server so AI agents can navigate and operate the workspace.

Worktrees share the object database for free, so the bare repo is not a redundant reference store — it is simply the layout that lets every branch (the default included) be a peer directory instead of one privileged checkout. What sync-worktrees adds is the bookkeeping around that primitive — mirroring the remote, pruning deleted branches, fast-forwarding clean trees on a schedule, across many repos from one config — not the worktrees themselves.

One caveat worth naming: this shared store covers the repository's own objects only. Submodules keep Git's normal per-worktree behavior, so each worktree maintains its own submodule checkout rather than sharing one across worktrees.
