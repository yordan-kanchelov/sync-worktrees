---
"sync-worktrees": minor
---

feat: add Git LFS error handling and skip option

- Added `--skip-lfs` CLI option to bypass Git LFS downloads when fetching and creating worktrees
- Added `skipLfs` configuration option for config files
- Implemented automatic retry with LFS skipping when LFS errors are detected
- Added branch-by-branch fetching as fallback when fetch-all fails due to LFS errors
- Enhanced retry mechanism to detect and handle LFS-specific errors
- Added `maxLfsRetries` configuration to prevent infinite retry loops on persistent LFS errors
- Improved error resilience for repositories with missing or corrupted LFS objects
- Fixed E2E tests to handle different Git default branch configurations