---
"sync-worktrees": patch
---

The folded log line in the TUI said "l to expand" even when it was folded for lack of room, where only `+` works; it now names the key that expands it. The log also keeps its scroll position when a modal such as help is opened and closed, instead of jumping back to the tail.
