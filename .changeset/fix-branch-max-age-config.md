---
"sync-worktrees": patch
---

Fix branchMaxAge configuration not being applied from config files

- Fixed issue where `branchMaxAge` setting was not being copied during config resolution
- The branch age filter now properly works when configured in repository-specific or default settings