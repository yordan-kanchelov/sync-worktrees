---
"sync-worktrees": minor
---

Upgrade the MCP server to the 2026-07-28 protocol revision (`@modelcontextprotocol/server` v2). The stdio server now serves the 2026-07-28 revision and keeps serving 2025-era clients from the same tool registry, so existing MCP clients continue to work unchanged.

Tools now advertise `outputSchema` and return `structuredContent` alongside the existing JSON text block, and `tools/list` / `resources/list` carry cache hints so clients can avoid re-fetching a static tool registry.
