---
"sync-worktrees": patch
---

Cross-process repository locking, git inactivity timeouts, trash reaping and periodic `git gc` are no longer silently disabled when the caller's environment already exports `NODE_ENV=test`; those unit-test shortcuts now hinge on the tool-owned `SYNC_WORKTREES_UNIT_TEST` variable, and the CLI and MCP server print a prominent warning at startup if it is active.
