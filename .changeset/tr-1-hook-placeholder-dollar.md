---
"sync-worktrees": patch
---

Hook placeholders whose value contains `$` (e.g. branch `fix/price$` or a URL with `pa$$word`) or another placeholder no longer corrupt the hook command; each placeholder is now substituted exactly once with its quoted value.
