---
"sync-worktrees": patch
---

fix: correctly detect squash-merged branches with deleted upstreams

Fixed a bug where worktrees for squash-merged branches (where the remote branch was deleted) were incorrectly flagged as having "unpushed commits" even when they had never been touched locally.

The issue occurred because `hasUpstreamGone()` returned `false` when Git couldn't resolve `@{upstream}` due to the remote branch being deleted. This caused the metadata-based check to be skipped, falling back to `git rev-list --count <branch> --not --remotes`, which incorrectly counted the original (now-squashed) commits as "unpushed".

The fix checks the branch's upstream configuration when `@{upstream}` resolution fails, and verifies whether the configured remote branch actually exists. This allows the metadata-based check to run, which correctly reports zero unpushed commits for untouched worktrees.
