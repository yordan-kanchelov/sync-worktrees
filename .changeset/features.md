---
"sync-worktrees": minor
---

New features:

- **Auto-discover config in CWD** — running `sync-worktrees` in a directory now probes for `sync-worktrees.config.{js,mjs,cjs}` and auto-loads it when no `--config` flag or single-repo CLI args are passed. Interactive wizard now routes the saved config through the same multi-repo pipeline, so first-run and subsequent runs share one execution path.
- **Worktree status view** — press `w` in the interactive UI to see health/status of all worktrees at a glance, with indicators for uncommitted changes, unpushed commits, stashes, operations in progress, and deleted upstream branches. Press Enter on any worktree to expand detailed file counts and reasons.
- **Diverged directory management** — inspect and delete `.diverged` directories (worktrees preserved when their remote branch was deleted but local changes existed) directly from the status view. Shows original branch name, size, and divergence date; press `d` to delete with `y/n` confirmation.
- **Lifecycle hooks** — `onBranchCreated` hook support lets users run commands (open editor, start tmux session, etc.) when a new branch worktree is created via the interactive UI.
- **Branch creation wizard** — filtering/search for projects and branches, fetch before listing.
- **InteractiveUIService improvements** — config reload support, parallel execution with p-limit, grouped cron jobs, graceful shutdown via signal handlers.
