---
"sync-worktrees": patch
---

Fix orphaned directory cleanup when worktree creation fails

- Clean up orphaned directories before creating worktrees to handle cases where previous attempts failed (e.g., due to LFS errors)
- Check if a directory is already a valid worktree before attempting to create it
- Prevent "already exists" errors when retrying after failures