---
"sync-worktrees": patch
---

In the interactive UI, worktree metadata and status-probe log lines now reach the log panel instead of the terminal underneath it. `GitService.updateLogger` propagates to the metadata and status services it owns, cached git clients read the current logger for each progress event rather than the one they were built with, and a reload builds its services with the UI logger already in the config, so nothing `initialize()` logs escapes to the console.
