---
"sync-worktrees": patch
---

Fix branch creation failing when starting the app fresh without running sync first. The issue was that `GitService.initialize()` only fetched remote refs during initial clone. Now it always fetches to ensure remote refs are available for the branch creation UI.
