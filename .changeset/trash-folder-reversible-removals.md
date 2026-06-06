---
"sync-worktrees": minor
---

Reversible removals via a per-workspace trash folder.

Every removal — age-based prune, orphan cleanup, diverged-branch replacement, and manual `remove_worktree` — now moves the directory into `<worktreeDir>/.trash/<id>/payload/` instead of deleting it, with a JSON manifest recording the branch, reason, original path, size, and expiry. Each entry is retained 30 days on its own clock (`trash.retentionDays`), then deleted by a reaper that runs at the tail of a successful sync inside the repo lock. The reaper only touches manifested entries whose real path stays under the trash root, and each delete is gated on a durable audit-log record.

- `trash` config (worktree mode only): `{ enabled: true, retentionDays: 30, warnSizeBytes?, migrateLegacy: true }`. Disabling restores direct deletion and leaves existing trash untouched.
- A pin ref (`refs/sync-worktrees/trash/<id>`) keeps the trashed HEAD's objects alive through `git gc` for the retention window, so restore can recreate the branch at the exact commit even after the local and remote-tracking refs are gone.
- New MCP tools: `list_trash` (entries, totals, soonest expiry) and `restore_trash <id>` (recreates the branch + worktree at the pinned commit and overlays the preserved files; falls back to a plain directory restore for branchless entries). `list_worktrees` now reports a per-repo trash summary.
- Existing `.removed/` quarantines and `.diverged/` backups in their exact shipped formats are adopted into the trash on the next sync (`trash.migrateLegacy`), so they age out under the same retention policy; unrecognized content is warned about and left alone.
- Failure to move a directory into trash (e.g. a cross-device rename) skips the removal entirely — the worktree stays in place.
- A leftover local branch ref after a successful trash move is reported as a structured warning (`leftover_branch_ref`) instead of failing the removal — the payload and pin ref already capture everything restore needs. The reaper also sweeps orphaned pin refs whose trash entry no longer exists, so nothing stays pinned through `git gc` forever.
