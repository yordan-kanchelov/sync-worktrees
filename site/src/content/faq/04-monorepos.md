---
question: "Does it work with monorepos?"
order: 4
---

Yes. Per-repo branch include/exclude globs and sparse checkout let you scope each worktree to the slice of the monorepo you care about, and `branchMaxAge` keeps stale branches out. One monorepo can be listed several times under different names with different `sparseCheckout` sets; each entry keeps its own bare repository, so history is stored once per entry. In cone mode a sparse worktree is only fast-forwarded when an upstream change lands inside its set, so git can report it as behind in the meantime — [Sparse checkout](https://github.com/yordan-kanchelov/sync-worktrees/blob/main/docs/sparse-checkout.md) covers how to turn that off.
