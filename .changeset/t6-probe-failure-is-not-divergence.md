---
"sync-worktrees": patch
---

Worktree mode no longer treats a fast-forward or local-ahead probe that could not run (a `git merge-base` that failed to spawn under EMFILE/ENOMEM, or exited with a `fatal:` error) as a diverged branch: such a worktree is now recorded as `update_check_failed` and left alone, where before a healthy, fully pushed worktree could be moved to `.trash/` (or `.diverged/`) and recreated from origin on nothing but a probe error. Diverged handling also re-checks with `git rev-list --left-right --count` that HEAD and `origin/<branch>` really have commits on both sides before it resets or moves anything — a probe that cannot answer aborts with `diverged_recovery_failed`, and a worktree that turns out to be at the remote tip, only ahead, or only behind is recorded as `already_up_to_date`, `local_ahead`, or `not_diverged` and left for the next sync.
