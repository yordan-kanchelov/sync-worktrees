---
"sync-worktrees": patch
---

TUI fixes:

- The status bar says `Idle` instead of `Running`, and shows how the last sync went next to its time: `✓ OK`, `✗ 2 failed` or `⚠ 1 skipped`.
- `Next Sync` is shown when repositories use different cron schedules (the earliest next run across all of them).
- `s`, `r` and `x` during a sync briefly say a sync is in progress instead of doing nothing.
- `q` while a sync, hook or worktree creation is running asks for a second `q` before quitting.
- `r` and `s` after `q` no longer restart the cron jobs or start a new sync during shutdown.
- Force clean (`x`) says "Nothing to clean" when there is nothing to delete, and otherwise asks you to type `clean` and press Enter instead of a single `y`.
- A failed delete of a `.diverged/` directory in the worktree status view is now shown instead of disappearing silently.
- Pressing down on an empty filtered list no longer leaves the selection at -1; a single configured repository is loaded by its own index.
