---
"sync-worktrees": minor
---

feat(mcp): inline connect-time worktree context into MCP `instructions`

When the MCP server starts inside a managed sync-worktrees worktree, the `instructions` field served to the client now includes a `Connect-time context` block with `kind`, `currentWorktreePath`, `currentBranch`, and `configPath`. This lets agents orient without an initial `detect_context` round-trip.

Snapshot is captured once at server construction. Sibling worktree lists, sibling repository lists, and capability state are intentionally **not** inlined — they belong behind a tool call to avoid prompt staleness and false-authority risk. Base guidance still directs the agent to call `detect_context` for live state.

Falls back to the original static instructions when started outside a managed worktree.
