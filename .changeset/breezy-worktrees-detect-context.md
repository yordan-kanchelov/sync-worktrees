---
"sync-worktrees": patch
---

Make MCP repository discovery config-driven across multi-repo workspaces. `detect_context` now reports configured sibling repositories, including nested worktree directories and missing bare repo presence, can include all configured repo worktrees with `includeAllWorktrees`, and surfaces per-repo worktree enumeration errors. `list_worktrees` without `repoName` now groups worktrees across all configured repositories.
