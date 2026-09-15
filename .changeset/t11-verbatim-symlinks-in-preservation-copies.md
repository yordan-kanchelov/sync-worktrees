---
"sync-worktrees": patch
---

Symlinks now survive the two copies that exist to preserve files before their source is deleted: the cross-device fallback that sets a diverged worktree aside under `.diverged/`, and `sync-worktrees trash --restore`, which overlays the trashed payload onto the recreated worktree. Both copied with `fs.cp` and no `verbatimSymlinks`, so Node resolved every relative link target against the source directory and wrote the copy's link as an absolute path back into that tree — which each operation then deletes. The preserved or restored worktree was left with links pointing at nothing. Links are a small share of a dependency tree's files but the load-bearing share — in this repository's own `node_modules`, 24 of the 30 top-level entries are links into the pnpm store — so the tree stops resolving; and a symlink committed to the repository came back as a `git status` modification. Ordinary files, permissions and directories are copied exactly as before.
