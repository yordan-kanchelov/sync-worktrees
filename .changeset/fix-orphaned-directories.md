---
"sync-worktrees": patch
---

Fix worktree sync failing on restart due to orphaned directories

- Changed worktree detection to use Git's actual worktree list (`git worktree list`) instead of filesystem directories
- Added automatic cleanup of orphaned directories that exist on disk but aren't registered Git worktrees
- Fixed the error "fatal: '/path/to/worktree' already exists" that occurred when restarting after directories were left behind
- Added comprehensive tests for edge cases including orphaned directory handling

This ensures the tool works correctly even after system restarts or when directories exist without corresponding Git worktree metadata.