---
"sync-worktrees": patch
---

`trash drop-keep-ref` no longer reports success for a keep ref that does not exist, and refuses a keep ref a `.diverged/` directory still depends on, matching the batch drop. Keep-ref drop output now uses the short names the commands accept.
