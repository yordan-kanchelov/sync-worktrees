---
"sync-worktrees": patch
---

A worktree kept for uncommitted changes now says which: the reason names the changed paths when there are three or fewer, marking untracked ones (`uncommitted changes: 'package-lock.json' (untracked)`), and counts them past that (`uncommitted changes (8 tracked, 3 untracked)`). A stray file — an accidental lockfile, a scratch note — is told apart from real work straight from the sync log, `--dry-run`, the TUI status view and the MCP status tools, instead of by opening the worktree; such a file is best ignored through `.gitignore`, `.git/info/exclude` or the global `core.excludesFile`, which the removal check already honours. The reason still starts with `uncommitted changes`.
