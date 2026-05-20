---
"sync-worktrees": minor
---

Add `mode: "clone"` repository strategy. When set, the tool runs `git clone --branch <X> --single-branch` directly into `worktreeDir` — no bare repo, no `worktreeDir/<branch>` subfolder — and on each sync tick fetches + fast-forwards if the working tree is clean. Designed for monorepo sibling dependencies that require fixed relative paths between repos. The default mode remains `worktree` (no behavior change for existing configs).
