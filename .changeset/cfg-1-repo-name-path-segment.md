---
"sync-worktrees": patch
---

Repository names reserved only on Windows (such as `aux` or `con`) now sync instead of failing, and a name that cannot become a path segment (such as `..`) is rejected when the config loads, at `repositories[i].name`, instead of breaking sync, the TUI and `doctor` later. `doctor` also reports a repository whose checks throw as a failed check rather than crashing.
