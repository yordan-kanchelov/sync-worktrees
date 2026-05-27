---
question: "Is it safe with uncommitted work?"
order: 7
---

Yes. Sync operations never merge or rebase your working copies. They fetch, create missing worktrees, fast-forward eligible existing worktrees, and prune only when the safety checks pass. Worktree removal refuses on dirty trees, unpushed commits, stashes, or in-progress operations (merge/rebase/cherry-pick/revert/bisect). Newly created branches are pushed with explicit `--no-track` so they don't inherit `origin/main` as upstream by accident.
