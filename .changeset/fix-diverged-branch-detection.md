---
"sync-worktrees": patch
---

Fix diverged branch detection and recovery mechanism

- Improve `canFastForward` detection using merge-base comparison for more reliable divergence detection
- Add recovery mechanism for fast-forward failures during updates

This fixes the issue where branches that cannot be fast-forwarded would fail with an error instead of being properly handled as diverged branches.
