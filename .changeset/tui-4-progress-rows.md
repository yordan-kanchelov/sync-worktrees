---
"sync-worktrees": patch
---

The TUI status bar no longer reserves a progress row per `maxRepositories` slot: it shows at most one row per repository and never more than the terminal can hold, so small setups lose the blank rows and tall limits no longer overflow the screen. Progress events that arrive between syncs (branch wizard fetches, default-branch resolution) are dropped instead of lingering into the next sync.
