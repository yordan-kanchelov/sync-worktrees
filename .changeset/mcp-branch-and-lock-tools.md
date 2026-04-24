---
"sync-worktrees": minor
---

Expand MCP server with branch introspection and lock-aware operations:

- New `list_branches` tool: remote/local branches enriched with `lastActivity`, `hasWorktree`, `matchesConfigFilter`; returns `branchesWithoutWorktrees` and `branchesFilteredByConfig` to answer "which branches need a worktree" without round-tripping sync.
- New `compare_branch` tool: structured verdicts (`safe-to-remove`, `would-lose-work`, `can-fast-forward`, `up-to-date`, `local-ahead`, `diverged-needs-review`, `no-upstream`, `no-local-branch`) for a worktree path or bare-repo branch, intended as a pre-flight check before remove/update.
- `list_worktrees` gains `includePendingDetails`: each entry can now carry `pendingWork` (`dirtyFiles`, `untrackedCount`, `unpushedCommits`, `stashes`) for cross-worktree "what's unfinished" queries without N calls to `get_worktree_status`.
- Worktree lock awareness: `parseWorktreeListPorcelain` captures `lockedReason`, `GitService.isWorktreeLocked` exposes it, `remove_worktree` with `force=true` now runs `git worktree remove --force --force` (removes locked worktrees), and `update_worktree` refuses to fast-forward a locked worktree.
- `GitService.getBranchDivergence` / `getDivergenceFromWorktree` centralize ahead/behind computation (previously inlined in the MCP handler).
- `ProgressEvent` gains optional `correlationId` for downstream consumers that need to correlate streamed progress with a specific sync invocation.
