---
"sync-worktrees": minor
---

feat: add comprehensive safety checks to prevent accidental worktree deletion

- Added stash detection to preserve worktrees with stashed changes
- Added submodule modification detection to protect worktrees with dirty submodules
- Added Git operation detection (merge, rebase, cherry-pick, bisect, revert) to prevent deletion during ongoing operations
- Enhanced error handling with conservative approach - when in doubt, don't delete
- Improved logging to clearly indicate why each worktree deletion was skipped

This ensures that no worktree with any type of changes or ongoing operations will be accidentally deleted, providing robust data protection for developers.
