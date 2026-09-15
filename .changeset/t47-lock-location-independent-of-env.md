---
"sync-worktrees": patch
---

The cross-process repository lock now lives next to the checkout, in `<parent of worktreeDir>/.sync-worktrees-locks/`, instead of under `$XDG_STATE_HOME` or `~/.cache`, so a daemon started by systemd/launchd/cron and a `--runOnce` from an interactive shell (or `sudo` with and without `-E`) always contend for the same lock file; `SYNC_WORKTREES_LOCK_DIR` overrides the directory when that parent is not writable and must be set identically for every process sharing a `worktreeDir`.
