---
---

Internal only: dropped the unreachable `GitService` methods `localBranchExists`, `hasDivergedHistory`, `pruneWorktrees`, `hasUnpushedCommits`, `hasUpstreamGone`, `hasModifiedSubmodules`, `getCurrentBranch` and `getLocalBranches`, plus `PathResolutionService.normalizeWorktreePath` / `extractBranchFromWorktreePath`. The first two were silently broken — simple-git resolves a non-zero exit with an empty stderr, so `show-ref --verify --quiet` answered "the branch exists" for every name and `merge-base --is-ancestor` answered "can fast-forward" for every history — and nothing called them, so no behavior changes.
