---
"sync-worktrees": patch
---

Clone mode no longer runs `git gc` (including `--prune=now` with `maintenance.aggressive`) when `worktreeDir` is a linked worktree or submodule of another repository; maintenance now applies the same primary-checkout check as every other write and skips with a warning.
