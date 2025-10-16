---
"sync-worktrees": patch
---

Fix false positive "unpushed commits" warnings for branches with slashes in names

Fixed a critical bug where branches with slashes in their names (e.g., `fix/test-branch`, `feature/new-feature`) would incorrectly report "unpushed commits" even when they were cleanly synced and merged.

**Root Cause:**
- Git stores worktree metadata using the basename of the worktree path (e.g., `.git/worktrees/test-branch/`)
- sync-worktrees was using the full branch name with slashes (e.g., `.git/worktrees/fix/test-branch/`)
- This path mismatch caused metadata loading to fail, triggering false positives

**Changes:**
- Added path-based metadata methods that correctly derive the worktree directory name from the worktree path
- All metadata operations now use `path.basename()` to match Git's internal structure
- Added automatic migration from old incorrect paths to new correct paths
- Updated all callsites in GitService to use the new path-based methods

**Migration:**
Existing worktrees with metadata in the old (incorrect) path will be automatically migrated to the correct path on first load. The old metadata files will be cleaned up automatically.
