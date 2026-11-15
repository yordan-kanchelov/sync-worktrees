---
"sync-worktrees": patch
---

A key set to `undefined` inside a nested config block (`retry`, `parallelism`, `hooks`, `maintenance`, `trash`) no longer resets the value inherited from the top level or `defaults` to the built-in default; it now inherits, as top-level keys already did.
