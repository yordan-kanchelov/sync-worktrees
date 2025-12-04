---
"sync-worktrees": patch
---

Fix false "diverged branch" detection when local is ahead of remote

Previously, when a local branch had unpushed commits (ahead of remote), the sync would incorrectly treat it as a diverged branch and move the worktree to `.diverged/`. This happened because `canFastForward` returns false when local is ahead of remote.

Now, when a branch cannot fast-forward, we check if local is simply ahead of remote (has unpushed commits). If so, we skip the worktree with a message instead of treating it as diverged. Truly diverged branches (where local and remote have different commits not in a linear history) are still handled correctly.
