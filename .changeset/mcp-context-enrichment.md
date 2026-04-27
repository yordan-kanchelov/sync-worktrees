---
"sync-worktrees": minor
---

Enrich MCP context discovery and worktree summaries.

- `detect_context` now walks up from the inspected path to auto-load `sync-worktrees.config.{js,mjs,cjs,ts}`, lists sibling repositories under the workspace root, and exposes `configPath` plus `notes[]` (renamed from `reasons`). The redundant `configLoaded` field is dropped — derive from `configPath !== null`.
- Capabilities shape changed from `{ canX: boolean }` to `{ x: { available: boolean, reason?: string } }`, so consumers can see exactly why a capability is gated.
- `detect_context` accepts `includeStatus` to enrich `allWorktrees` with `label`, `divergence`, and `staleHint`.
- `list_worktrees` accepts `includeSize` (returns `sizeBytes`) and now returns `safeToRemove` as `{ safe, reason }` instead of a raw boolean.
- New `ConfigLoaderService.findConfigUpward()` helper for upward config discovery.
