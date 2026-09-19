---
question: "Is it safe with uncommitted work?"
order: 7
---

Yes. Uncommitted and untracked changes in a worktree are never touched: a folder with work in it is skipped by the phases that update, replace or remove anything, and a clean folder is fast-forwarded only when it has nothing unpushed. The one case where sync replaces a folder is a branch that has commits of its own *and* upstream commits it doesn't have, and even then it sets the old folder aside with your commits kept rather than merging or rebasing for you. By default nothing is deleted outright, so a folder that does get removed can be brought back. Every removal path, its checks and how to undo it: [trash and recovery](https://github.com/yordan-kanchelov/sync-worktrees/blob/main/docs/trash-and-recovery.md).
