---
"sync-worktrees": minor
---

Improve warning messages for branches with deleted upstream

When a branch's upstream is deleted (e.g., after squash merge), sync-worktrees now shows clearer messages explaining why the worktree cannot be automatically removed. The new messages guide users to manually review and clean up if their changes were already integrated.

**Example:**
```
⚠️ Cannot automatically remove 'feat/LCR-5982' - upstream branch was deleted.
   Please review manually: cd worktrees/feat/LCR-5982 && git log
   If changes were squash-merged, you can safely remove with: git worktree remove worktrees/feat/LCR-5982
```