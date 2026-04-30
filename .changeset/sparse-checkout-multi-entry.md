---
"sync-worktrees": minor
---

Add `sparseCheckout` config option for monorepos. Each repo entry can declare `{ include, exclude?, mode? }` to clone only a subset of folders/files. Cone mode is the default; explicit excludes or `!`-negation patterns auto-promote to `no-cone`.

Same `repoUrl` may now appear under multiple repository entries with different `name`s, sparse patterns, and `worktreeDir`s. The first entry per `repoUrl` keeps the URL-derived bare path (`.bare/<repo-slug>`); subsequent duplicates auto-derive `.bare/<sanitized-name>` so they do not collide. Pin `bareRepoDir` explicitly to make config order irrelevant.

Sync-time reapply reconciles existing worktrees with the latest sparse config in parallel. Narrowing (removing previously included paths) is skipped with a warning when the worktree has uncommitted changes. Worktree creation now uses `git worktree add --no-checkout` followed by sparse setup and `git checkout HEAD`, with transactional rollback (worktree remove + branch delete for newly created branches) on any post-add failure. LFS verification picks up `GIT_ATTR_SOURCE=HEAD` so `.gitattributes` is honored under sparse on Git ≥ 2.42.
