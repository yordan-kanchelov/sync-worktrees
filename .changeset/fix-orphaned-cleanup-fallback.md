---
"sync-worktrees": patch
---

Fix orphaned directory cleanup in LFS error fallback path

- Added orphaned directory cleanup when worktree tracking setup fails
- Prevents directories from being left behind after LFS errors or other failures during retry
- Ensures consistent cleanup behavior across all error scenarios