---
"sync-worktrees": patch
---

Fix LFS verify failing on sparse-checkout worktrees when shell `EDITOR` is set. simple-git's argv-parser blocks `EDITOR`/`GIT_EDITOR`/`GIT_SEQUENCE_EDITOR` env vars unless `allowUnsafeEditor` is enabled, causing `git lfs ls-files` to error out and skip verification. The forwarded env now strips these vars before passing to simple-git.
