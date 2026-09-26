---
"sync-worktrees": minor
---

Add `sync-worktrees --dry-run`: prints what a sync would do to each repository (worktrees to create, fast-forward, prune with the reason it is safe to, replace after a divergence, and skip with the reason) and exits without changing anything. It fetches like a sync does, so remote-tracking refs are updated; nothing else is written, and git runs with optional locks off so even `git status` leaves every index alone. Works in worktree and clone mode, honours `--filter`, needs no terminal, and `--json` prints the plans as a JSON array. Exits 1 only when a repository could not be planned. See `docs/dry-run.md`.
