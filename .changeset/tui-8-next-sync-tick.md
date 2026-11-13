---
"sync-worktrees": patch
---

The TUI status bar's "Next Sync" could show a time already in the past for up to a minute, because it refreshed on a timer phased to when the TUI started. It now refreshes just after each scheduled tick and whenever a sync finishes or the status changes.
