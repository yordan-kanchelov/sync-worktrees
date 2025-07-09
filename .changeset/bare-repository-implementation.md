---
"sync-worktrees": minor
---

feat: implement space-efficient bare repository storage

- Changed from regular Git repositories to bare repositories with worktrees
- Replaced `repoPath` CLI parameter with automatic bare repository management
- All worktrees now share a single Git object database, significantly reducing disk usage
- Added utilities for Git URL parsing and improved test structure
