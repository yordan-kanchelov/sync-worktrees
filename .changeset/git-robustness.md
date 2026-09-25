---
"sync-worktrees": patch
---

Make git invocations more robust:

- Every git client now runs under the C locale (`LC_ALL=C`, `LANG=C`), not only the sync clients, so the status view, metadata, sparse-checkout, maintenance and MCP paths that match git's English messages keep working under a non-English locale.
- `fetchTimeoutMs` / `cloneTimeoutMs` must be `0` or a whole number of milliseconds from 1000 to 2147483647. Larger values used to overflow Node's timer and kill every git command after 1 ms; sub-second values killed nearly every fetch.
- `git worktree list` is read NUL-terminated (`-z`, git 2.36+, with a fallback for older git), so a worktree path containing a newline is no longer split into two bogus entries.
- `git branch -D` calls now pass `--` before branch names.
- A pin or keep ref that cannot be removed while rolling back a failed trash or diverged-worktree preservation is now logged as a warning instead of being silently ignored.
