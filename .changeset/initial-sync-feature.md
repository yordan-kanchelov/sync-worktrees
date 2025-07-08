---
"sync-worktrees": minor
---

Add initial sync when running in scheduled mode

When running sync-worktrees in scheduled mode (without --runOnce flag), the tool now performs an initial sync immediately upon startup before waiting for the first scheduled run. This ensures worktrees are synchronized right away instead of waiting for the next cron trigger.