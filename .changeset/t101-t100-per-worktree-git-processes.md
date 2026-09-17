---
"sync-worktrees": patch
---

`list_worktrees` and `detect_context` stop spending git processes on work they had already done.

The worktree status result now carries `divergence {ahead, behind}`, taken from the `## <branch>...<upstream> [ahead N, behind M]` header `git status -b` already prints. The MCP layer used to follow every status probe with a separate `rev-list --left-right --count HEAD...@{upstream}` on a simple-git client it built for that one command — outside the status service's process budget — to learn the same two numbers. It no longer does, and a worktree with no upstream to compare against still reports `null` rather than a fabricated 0/0.

`detect_context {includeStatus: true, includeAllWorktrees: true}` passed both `allWorktrees` and `allWorktreesByRepo[<current repo>]` through enrichment independently. Those two lists are separate `worktree list --porcelain` reads of the same repository, so every worktree of the current repo was probed twice. Each path is now probed once and both lists report that one answer.

Measured with a `git` shim on PATH against a 40-worktree repository: `list_worktrees` 321 → 281 git processes, `detect_context` 641 → 281.

The discovery cache is also bounded now, at 64 probed paths, least-recently-used first out. It was keyed by probed path and entries were only ever marked stale, never removed, so a long-lived MCP server retained a full `allWorktrees` array for every directory it had ever been pointed at. An evicted path is simply re-detected, exactly as a cache-TTL expiry already forces.
