---
"sync-worktrees": patch
---

`--run-once` and the TUI scheduler no longer fetch twice per repository on every start, and the initial clone or fetch now follows the configured retry policy instead of failing after one attempt. Clone mode also reports an init-time skip once instead of twice.
