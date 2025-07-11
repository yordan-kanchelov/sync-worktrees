---
"sync-worktrees": minor
---

Add branch age filtering feature to only sync recently active branches

- Added `--branchMaxAge` CLI option to filter branches by last commit activity
- Support for duration formats: hours (h), days (d), weeks (w), months (m), years (y)
- Can be configured globally or per-repository in config files
- Helps reduce clutter and save disk space by ignoring stale branches
- Example: `--branchMaxAge 30d` only syncs branches active in the last 30 days