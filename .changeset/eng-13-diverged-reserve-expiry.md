---
"sync-worktrees": patch
---

A diverged-replace trash entry that outlived its expiry (because the reaper could not finish removing it) kept its branch from ever syncing again. The reservation now ends at the entry's `expiresAt`, and an entry with an unparseable expiry no longer reserves its branch.
