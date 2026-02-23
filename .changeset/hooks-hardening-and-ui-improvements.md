---
"sync-worktrees": minor
---

Add lifecycle hooks system with `onBranchCreated` hook support, allowing users to run commands (e.g., open editor, start tmux session) when a new branch worktree is created via the interactive UI.

Also includes:
- Branch creation wizard UX improvements: filtering/search for projects and branches, fetch before listing
- InteractiveUIService refactoring: config reload support, parallel execution with p-limit, grouped cron jobs, graceful shutdown via signal handlers
- Metadata service hardening: atomic writes, branch name sanitization in paths, auto-create metadata on update when missing
- Path resolution security fix: use `path.resolve()` to prevent path traversal edge cases
- Config loader fixes: resolve `filesToCopyOnBranchCreate` paths relative to config dir, escape special characters in wildcard filters
- Worktree sync safety: skip removal on status check failure instead of risking dirty worktree removal, rollback worktree on metadata creation failure, LFS skip via service method instead of mutating `process.env`
