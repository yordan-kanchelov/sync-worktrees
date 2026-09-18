---
question: "Does it work with monorepos?"
order: 4
---

Yes. Per-repo branch include/exclude globs and sparse checkout let you scope each worktree to the slice of the monorepo you care about, and `branchMaxAge` keeps stale branches out. One monorepo can be listed several times under different names with different `sparseCheckout` sets; each entry keeps its own bare repository, so history is stored once per entry, and LFS content is fetched per checkout unless `skipLfs: true`. A sparse worktree is left behind upstream (git shows it as behind) until a change lands inside its set (cone mode; no-cone always fast-forwards) — set `skipUpdateWhenOutsideSparse: false` to always fast-forward.
