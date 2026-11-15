---
"sync-worktrees": patch
---

Undoing a rejected fast-forward now also restores the old path of a file renamed upstream, so the clone no longer stays dirty and skips every later sync.
