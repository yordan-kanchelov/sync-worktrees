---
"sync-worktrees": patch
---

Pressing `r` in the TUI now applies a changed `parallelism.maxRepositories`; before, the old limit (and progress-row count) stayed in effect until the TUI was restarted.
