---
"sync-worktrees": minor
---

Add `mode: "clone"` repository strategy. When set, the tool runs `git clone --branch <X> --single-branch` directly into `worktreeDir` — no bare repo, no `worktreeDir/<branch>` subfolder — and on each sync tick fetches + fast-forwards if the working tree is clean. Clone-mode initialize/sync operations now also emit structured progress notifications for branch resolution, clone/fetch progress, sparse-checkout, LFS verification, skip reasons, and fast-forward updates. Designed for monorepo sibling dependencies that require fixed relative paths between repos. The default mode remains `worktree` (no behavior change for existing configs).
