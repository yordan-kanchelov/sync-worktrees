---
"sync-worktrees": patch
---

Concurrent writes of the same state file no longer fail with `ENOENT` (temp files now get a random suffix), an un-adoptable legacy `.removed/`/`.diverged/` entry is warned about once instead of on every sync, and `copyFiles` patterns no longer resolve the real path of every walked directory, only those reached through a symlink.
