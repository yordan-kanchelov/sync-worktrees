---
"sync-worktrees": patch
---

Directory sizing no longer fails when `du` cannot read one subdirectory (it now uses the total `du` prints), measures a symlinked worktree or bare-repo directory as its target instead of 0 B, and a trash payload that cannot be sized is not re-scanned on every sync.
