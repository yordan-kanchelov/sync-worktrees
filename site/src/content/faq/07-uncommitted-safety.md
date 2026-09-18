---
question: "Is it safe with uncommitted work?"
order: 7
---

Yes. Uncommitted and untracked changes are never touched: a dirty worktree is skipped by every phase. A clean worktree is fast-forwarded only when it has nothing unpushed. The one case where sync replaces a folder is a diverged branch — you have commits *and* upstream has commits you lack: it is moved to `.trash/` with its commits pinned and a fresh checkout of upstream takes its place, never merged or rebased for you. Removal refuses dirty trees, unpushed commits, stashes, in-progress operations (merge/rebase/cherry-pick/revert/bisect), modified submodules or a detached HEAD, and removal is a move to `.trash/` (30 days, `sync-worktrees trash --restore`). The one thing sync cannot tell apart is a plain directory you left at a managed branch's path: it is swept to `.trash/` when that branch's worktree is created (deleted outright only with trash disabled), so keep trash on in any folder you also use by hand. Branches created from the TUI are cut with `--no-track` and pushed create-only (`--force-with-lease` against an absent ref), so they track their own remote branch and an existing remote branch is never moved.
