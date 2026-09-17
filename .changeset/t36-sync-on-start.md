---
"sync-worktrees": minor
---

The daemon syncs once at startup again, controlled by a new `defaults.syncOnStart` (default `true`).

Bare `sync-worktrees` built its services, wired the TUI, scheduled the cron jobs and then did nothing until the first tick. With the `0 * * * *` schedule `sync-worktrees init` writes, running `sync-worktrees` at 10:05 printed `📋 1 repositories configured` and sat there — no bare repo, no worktrees — until 11:00, unless you knew to press `s`. The README has said the bare command "starts syncing" throughout. A daemon restarted after a config change had the same hole: the new config was loaded but nothing acted on it for a full schedule period.

An initial sync existed in 3.x, became opt-in behind `--sync-on-start`, and 4.0.0 removed that flag with the rest of the CLI surface without naming a config replacement. `defaults.syncOnStart` is that replacement, and it is on by default rather than opt-in: waiting is the surprising behaviour, not the sync.

**This changes what an existing daemon does on restart.** A restart now runs one sync immediately instead of waiting for the next tick. Set `defaults.syncOnStart: false` to keep the old behaviour — the cron schedule is untouched either way, and `--runOnce` is unaffected (it already syncs once and exits, and never builds the UI the startup sync goes through).

The startup cycle is exactly what the first cron tick would have run: the same services, the same lazy initialize, the same parallelism limit. The one difference is that a failure is written to the log panel, which a cron tick does not do — on the first sync of a run "why are there no worktrees" deserves an answer, while a tick stays quiet and retries. It runs after the interface is on screen and after the `📋`/`⏰` summary lines, and is not awaited, so a slow first fetch never holds up startup.

`syncOnStart` is a whole-file setting like `runOnce`: one process runs every repository in the config, so it cannot be scheduled for some and skipped for others, and setting it on a repository entry is a validation error pointing at `defaults.syncOnStart`. It is a boolean, validated at load, included in the exported config types (so a `@ts-check`ed config file completes it), and registered with the unknown-key scan so a valid `defaults.syncOnStart` does not warn.

Because the startup cycle and the cron jobs are armed in the same breath, a tick landing inside the startup sync went from a rare `s`-during-a-sync to something every run can meet. The per-repository lock always stopped the second cycle doing any real work, but not before it had cleared each service's recorded clone-mode skips out from under the running one and driven the status bar back to idle mid-sync. So a cycle now claims a repository for as long as it is syncing it: an overlapping tick, or an `s`, leaves the repositories another cycle holds to that cycle and reports them as `Sync skipped for '<repo>': sync skipped: in_progress`, while the repositories nobody holds are synced. The status bar follows the number of cycles in flight rather than whichever one finishes first, so it stays on `Syncing...` until the last one is out.

`minor` rather than `patch`: a new public config key, and default behaviour changes for daemons that already exist. The only config that loaded before and fails now is one that already carried a stray `syncOnStart` on a repository entry, where the unknown-key scan warned about it and the loader dropped it; it is now a load error naming `defaults.syncOnStart`.
