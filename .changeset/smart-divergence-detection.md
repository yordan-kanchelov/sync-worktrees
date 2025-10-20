---
"sync-worktrees": minor
---

Smart divergence detection - only move worktrees to `.diverged` when you've made local changes

Enhanced divergence handling to avoid unnecessary `.diverged` moves. Previously, when someone force-pushed a branch (e.g., after a rebase), sync-worktrees would move your worktree to `.diverged` even if you hadn't made any local changes - it was just a stale snapshot of the old remote state.

**Changes:**
- Checks if you've made local commits since last sync using metadata
- If HEAD == lastSyncCommit: Just resets to new upstream (no local changes)
- If HEAD != lastSyncCommit: Moves to `.diverged` (preserve your work)
- If metadata is missing: Safely moves to `.diverged` (conservative default)

**Result:**
`.diverged` now only contains worktrees with actual user work that needs review, not stale upstream snapshots.
