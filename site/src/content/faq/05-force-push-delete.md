---
question: "What happens when a branch is force-pushed or deleted upstream?"
order: 5
---

Nothing of yours is overwritten, and nothing is merged or rebased for you. A force-push, or a teammate pushing the same branch, can leave your folder with commits upstream doesn't have: sync sets that folder aside with your commits kept, and checks out the new upstream in its place. If you made no commits of your own since the last sync, there is nothing to set aside and the folder is just brought up to date. A branch deleted upstream, or filtered out, has its folder removed only when it is clean; if it holds uncommitted changes, a stash, or commits you never pushed, it stays put and the TUI's status view flags it. By default nothing is deleted outright, and [trash and recovery](https://github.com/yordan-kanchelov/sync-worktrees/blob/main/docs/trash-and-recovery.md) has the full rules, including how to get your commits back.
