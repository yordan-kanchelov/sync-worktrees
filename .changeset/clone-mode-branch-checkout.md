---
"sync-worktrees": minor
---

Support branch switching for clone-mode repositories in the interactive TUI.

Previously a clone-mode repository tracked one fixed branch with no way to change it from the UI. Now the branch picker (`createWorktreeForBranch`) checks out the selected branch in place when the repository is in clone mode.

- **`checkoutBranch(branch)`** on clone-mode repos reconfigures the single-branch fetch refspec, fetches the target branch, switches to it, and prunes stale `origin/*` remote-tracking refs left by the previous branch.
- **`getRemoteBranches()`** now lists remote branches via `git ls-remote --heads` so the picker can show every branch without downloading object closure for each one.
- **Legacy refspec narrowing:** existing single-branch clones get their refspec narrowed on sync so a fetch no longer pulls unrelated remote branches; shallow clones stay materialized to the tracked branch only.
