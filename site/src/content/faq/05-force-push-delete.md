---
question: "What happens when a branch is force-pushed or deleted upstream?"
order: 4
---

If you have unique commits and upstream has new ones, the folder is moved to `.trash/` and a fresh upstream checkout takes its place. That work is never merged or overwritten in place; restore it from trash. If you have no unique commits, a clean tree is fast-forwarded or reset in place. A branch deleted upstream is pruned only if the tree is clean; otherwise it stays.
