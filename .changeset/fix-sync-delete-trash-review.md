---
"sync-worktrees": patch
---

Fix sync, removal and trash regressions found reviewing the cleanup-hardening work:

- Rebuild worktrees whose registration points at a directory that was deleted out-of-band. Without the start-of-sync `worktree prune`, git still reported the branch as checked out, so sync silently stopped restoring it.
- Recreating a worktree for a stale registration no longer fails permanently: the recovery path handed the already-missing directory to the trasher, which failed with `ENOENT`.
- A diverged branch is only held back from syncing while its trashed replacement was genuinely never created. Previously any later removal of the replacement re-armed the reservation, and `.diverged/` copies (which nothing restores from) or an unverifiable path check could hold a branch back for good.
- `resetToUpstream` indexes the upstream tree instead of comparing every ignored path against every tracked path, and lets git collapse wholly-ignored directories. The old scan blocked the event loop for minutes on a large ignored tree while holding the repo lock.
- Relocating `worktreeDir` no longer strands every existing trash entry as unrecognized content that is never reaped and never releases its pin ref. The restore destination is still confined to `worktreeDir`, checked where it is used.
- Force clean keeps recovery refs that a `.diverged/` directory still depends on, so it can no longer leave preserved files whose commits `git gc --prune=now` has already collected. It reports trash deletions from the reaper's own count and only purges repositories whose preview was shown in the confirmation.
- The fast-forward gate honours the repository's own `submodule.<name>.ignore` settings again. Overriding them there marked worktrees with vendored build output permanently dirty, so those branches silently stopped updating; removal checks keep the stricter view.
- The diverged-directory delete prompt in the TUI ignores further keys while a delete is running. Repeating `y` fired one removal per keypress, and `n`/ESC handed the list back mid-delete so the next confirmation showed "Deleting..." for an entry nothing was deleting.
- Force clean also keeps `keep/diverged-<timestamp>-<branch>` refs minted before this ref layout, matching them to their `.diverged/` directory by the sanitized branch name both carry. Those refs are the only thing holding the commits behind a preserved copy, and nothing else links them to it.
