---
"sync-worktrees": patch
---

Closing the worktree switcher no longer keeps listing worktrees for every remaining repository in the background, and the repository dashboard now renders once per update instead of twice, parsing each cron schedule at most once a minute.
