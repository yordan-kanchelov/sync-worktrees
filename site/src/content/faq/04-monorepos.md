---
question: "Does it work with monorepos?"
order: 4
---

Yes. Per-repo branch include/exclude globs and sparse-checkout support let you scope each worktree to the slice of the monorepo you actually care about. Combined with `branchMaxAge` to ignore stale branches, this keeps multi-million-line monorepos manageable on disk.
