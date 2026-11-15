---
"sync-worktrees": patch
---

A config reload while the TUI branch wizard is still adding a worktree, copying files or running hooks now stops the remaining steps with a log message, instead of running them against whichever repository took the original one's place in the list.
