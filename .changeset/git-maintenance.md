---
"sync-worktrees": minor
---

Add optional periodic Git object-store maintenance (`git gc`).

Over time a repository accumulates unreachable Git objects — clone mode leaves them behind when single-branch fetches narrow refs, and both modes churn objects as branches come and go. The new `maintenance` config block reclaims that storage and consolidates pack files on a schedule.

- **New config (both modes):** `maintenance?: { enabled?: boolean; interval?: string; aggressive?: boolean }`, settable per repository or in `defaults`.
- **Defaults:** `enabled: true`, `interval: "7d"`. With no config, repositories get a safe weekly `git gc`.
- **When it runs:** at the tail of a *successful* sync, inside the existing repository operation lock — so it never races a fetch, merge, branch checkout, or worktree add/remove. Throttled by `interval` via a timestamp persisted in the object store (`<bare-repo>/sync-worktrees-maintenance.json`, or `<worktreeDir>/.git/…` in clone mode), so throttling survives daemon restarts and repeated `runOnce` runs.
- **Targets:** worktree mode runs `git gc` against the shared bare repo; clone mode runs it against the checkout.
- **Safety:** the default runs plain `git gc`, honoring Git's two-week prune grace — reachable objects (branches, tags, stashes, reflog) are always preserved. `aggressive: true` runs `git gc --prune=now` for explicit immediate reclamation.
- **Isolation:** a maintenance failure is logged as a warning and never fails the sync; the attempt is still timestamped, so a broken `gc` is throttled instead of retried every tick.
