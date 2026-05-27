---
question: "Why use this instead of cloning each branch separately?"
order: 2
---

Cloning duplicates the entire Git object database for every branch — wasteful on disk and slow to refresh. Worktrees share one `.git` directory among many checkouts, so disk usage scales with working-tree size, not with branch count. sync-worktrees automates the bookkeeping you'd otherwise have to do manually (creating worktrees for new remote branches, removing stale ones, handling force-pushes safely).
