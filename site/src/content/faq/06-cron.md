---
question: "Can I run it continuously or on a cron?"
order: 6
---

Yes, two ways. `sync-worktrees` opens the TUI, syncs once immediately, then on `cronSchedule` (hourly by default, per-repo overrides) — leave it in `tmux` or `screen` on a laptop; a tick the machine slept through is not replayed. There is no headless daemon: on a build box or in CI put `sync-worktrees --runOnce --config <path>` on a cron line or a systemd/launchd timer. Overlapping runs don't collide: the second finds that repository already syncing, skips it and still exits 0.
