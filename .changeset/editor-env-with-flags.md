---
"sync-worktrees": patch
---

Fix "open in editor" failing with ENOENT when `EDITOR`/`VISUAL` contains flags (e.g. `code -w`).

The TUI passed the whole `EDITOR` string as the binary name to `spawn`, so values like `code -w` were treated as a single executable that does not exist. The editor command is now split into command and arguments before spawning.
