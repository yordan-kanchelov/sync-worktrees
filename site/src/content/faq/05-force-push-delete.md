---
question: "What happens when a branch is force-pushed or deleted upstream?"
order: 5
---

A branch has diverged when it has commits of its own *and* new upstream commits, which is what a force-push or a teammate's push to your branch produces. It is never merged or overwritten. The worktree is moved to `.trash/` with its commits pinned, and a fresh checkout of upstream takes its place (`.diverged/` only if you disabled trash). The plain force-push case is different. A worktree with no commits of your own since the last sync, or whose tree already matches upstream, is reset in place instead. Recover the commits from the trash entry and rebase or cherry-pick them; a dirty worktree never reaches this point, and one with a stash is skipped until you pop it. A branch deleted upstream (or filtered out) is pruned only when it is clean, with no uncommitted changes, unpushed commits, stashes, in-progress operations, modified submodules or detached HEAD. Pruned means moved to `.trash/`, restorable for 30 days with `sync-worktrees trash --restore`. Anything that fails the gate stays put and is flagged in the TUI's status view.
