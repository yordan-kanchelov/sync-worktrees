---
"sync-worktrees": patch
---

Repository URLs are now shown with embedded credentials stripped (`https://***@host/repo.git`) in logs, the `list` output, clone and origin-mismatch messages, git error text and MCP responses; git operations and the `SYNC_WORKTREES_REPO_URL` hook variable still receive the working URL.
