---
"sync-worktrees": patch
---

`detect_context` capabilities now match what the tools do: from the workspace root they report the selected repository's capabilities instead of all `false`, and for a bare repository without an `origin` URL the worktree tools (including `update_worktree`) are reported unavailable instead of failing with "No repository specified".
