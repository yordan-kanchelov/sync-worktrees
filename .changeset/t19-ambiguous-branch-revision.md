---
"sync-worktrees": patch
---

Unpushed commits are no longer hidden by a tag that shares the branch's name: the removal-safety probe now counts from the worktree's `HEAD` (and worktree metadata records the default branch's tip from `refs/heads/<default>`) instead of the bare branch name, which git resolves as a tag first — with only an "ambiguous refname" warning and exit 0 — so a hotfix branch cut from a same-named tag (`git checkout -b 1.4.2 1.4.2`) read as "clean, nothing unpushed" and could be pruned.
