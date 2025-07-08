---
"sync-worktrees": patch
---

Fix handling of branch names containing slashes

- Fixed orphaned directory cleanup to properly handle nested directory structures created by branches with slashes (e.g., `feat/feature-name`)
- Updated worktree removal to use full paths instead of branch names, ensuring Git can properly locate worktrees in nested directories
- Parent directories of slash-named branches are no longer incorrectly identified as orphaned and removed
- Resolves the issue where worktrees were repeatedly created and their parent directories removed in a cycle