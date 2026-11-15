---
"sync-worktrees": patch
---

`sync-worktrees list` reported sparse mode `cone` for a config that sets `exclude` or a `!` include, which the sync actually runs in `no-cone` mode. It now reports the mode the sync uses.
