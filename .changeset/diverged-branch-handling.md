---
"sync-worktrees": minor
---

Add smart handling for rebased and force-pushed branches

- Automatically detect when branches have been rebased or force-pushed
- Reset branches to upstream when file content is identical (clean rebase)
- Move branches with diverged content to `.diverged` directory
- Preserve local changes while keeping worktrees in sync with upstream
- Add comprehensive test coverage for all edge cases
- Prevent race conditions with unique diverged names
- Support branch names with special characters

This feature helps developers who work with rebased branches by automatically handling the common case where branches are rebased but have identical content, while safely preserving any local changes that differ from upstream.