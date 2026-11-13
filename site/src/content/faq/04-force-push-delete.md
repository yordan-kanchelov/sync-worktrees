---
question: "What happens when a branch is force-pushed or deleted upstream?"
order: 4
---

If you have unique commits and upstream has new ones, the folder is set aside and a fresh upstream checkout takes its place. That work is never merged or overwritten, and you can get it back. If you have no unique commits, a clean tree is brought up to date in place. A branch deleted upstream is removed only if the tree is clean; otherwise it stays.

See [trash and recovery](https://github.com/yordan-kanchelov/sync-worktrees/blob/main/docs/trash-and-recovery.md).
