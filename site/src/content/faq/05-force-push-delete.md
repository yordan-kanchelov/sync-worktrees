---
question: "What happens when a branch is force-pushed or deleted upstream?"
order: 5
---

A branch that has diverged — it has commits of its own *and* new upstream commits, which is what a force-push or a teammate's push to your branch produces — is never merged or overwritten: the worktree is moved to `.trash/` with its commits pinned and a fresh checkout of upstream takes its place (`.diverged/` only if you disabled trash). Recover the commits from the trash entry and rebase or cherry-pick them; a dirty worktree never reaches this point, and one with a stash is skipped until you pop it. A branch deleted upstream (or filtered out) is pruned only when it is clean — no uncommitted changes, unpushed commits, stashes, in-progress operations, modified submodules or detached HEAD — and pruned means moved to `.trash/`, restorable for 30 days with `sync-worktrees trash --restore`. Anything that fails the gate stays put and is flagged in the TUI's status view.
