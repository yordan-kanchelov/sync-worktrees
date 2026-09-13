---
"sync-worktrees": patch
---

Worktree mode now fast-forwards worktrees whose branch has no upstream configured — one restored from trash, one created by the MCP `create_worktree` tool with `push: false` and published later, or one registered through the no-tracking fallback. The update phase read the behind count through `<branch>@{upstream}`, which fails without an upstream, and took the failure as "not behind", so such a worktree was reported as `already_up_to_date` on every sync while `origin/<branch>` moved on. Behind is now derived from `origin/<branch>` explicitly (the same ref the fast-forward check and the merge use), a failed probe is recorded as `update_check_failed` for that worktree instead of passing as up to date, and a trash restore or a no-tracking fallback sets `origin/<branch>` as the branch's upstream when that remote branch exists, so `git pull` and `git status` in the worktree behave normally too.
