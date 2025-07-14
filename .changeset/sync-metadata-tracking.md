---
"sync-worktrees": minor
---

Add sync metadata tracking to accurately detect unpushed commits

Sync-worktrees now tracks synchronization metadata for each worktree, storing information about the last synced commit. This enables accurate detection of truly unpushed commits when a branch's upstream has been deleted (e.g., after squash merge).

**Benefits:**
- Accurately detects new commits made after the upstream was deleted
- Allows safe cleanup of worktrees whose changes were already integrated via squash merge
- Prevents false positives where all commits appeared as "unpushed" after upstream deletion

**Technical details:**
- Metadata is stored in Git's worktree directory: `.git/worktrees/[worktree-name]/sync-metadata.json`
- Automatically created when adding worktrees and updated during sync operations
- Backward compatible - works seamlessly with existing setups