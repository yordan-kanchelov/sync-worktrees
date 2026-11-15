---
"sync-worktrees": patch
---

A repeated `--filter` now selects the union of its patterns instead of failing with `filter.split is not a function`, and an empty `--filter ""` is a usage error instead of selecting every repository. A repeated, empty or missing `--config` value is now a one-line usage error instead of a crash or a silent fall back to config discovery.
