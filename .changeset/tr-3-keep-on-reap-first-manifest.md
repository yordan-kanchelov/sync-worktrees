---
"sync-worktrees": patch
---

A crash while a keep-on-reap trash entry was being created (during its commit bundle) left a container the tool rejected as invalid forever, with its pin ref keeping objects alive. The first manifest is now valid, so such an entry lists and ages out normally.
