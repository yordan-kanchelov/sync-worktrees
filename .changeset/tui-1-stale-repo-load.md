---
"sync-worktrees": patch
---

In the TUI status view, open wizard and branch wizard, a slow load for a repository you had already backed out of could replace the list shown for the repository you picked next, so delete, open and branch actions paired one repository with another's data. Late results for a repository you left are now discarded.
