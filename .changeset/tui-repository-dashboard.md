---
"sync-worktrees": minor
---

The TUI home screen now leads with a repository table instead of the log: one row per repository with its state (`● idle`, `⟳ syncing`, `✗ failed`, `⚠ skipped`), how its last sync went, how long ago that was, its worktree count, how many worktrees have uncommitted changes or unpushed commits (as of the last `w` status check), and when it runs next. The log sits underneath: `l` folds it to one line showing the latest entry, and `+` / `-` grow or shrink it. The table, the log heading and the status bar keep to one row per line in narrow terminals, dropping columns and switching to a short key legend rather than wrapping. The force-clean modal (`x`) now fits the rows above the status bar: it shortens its explanation and scrolls its per-repository list (`↑`/`↓`) instead of pushing the status bar off screen.
