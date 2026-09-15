---
"sync-worktrees": patch
---

Worktree mode no longer reports an update that did not happen. The fast-forward now reports whether HEAD actually moved: when the behind probe saw `origin/<branch>` ahead but the merge had nothing left to bring in (HEAD reached the remote tip in between, say through a `git pull` in the worktree), the sync records `noop already_up_to_date` for that worktree instead of `updated fast_forward`, logs no "Successfully updated" line, and leaves its `lastSyncCommit`, `lastSyncDate` and `syncHistory` untouched. The MCP `update_worktree` tool exposes the same fact as `updated: false` in its response.
