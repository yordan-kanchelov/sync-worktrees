---
"sync-worktrees": patch
---

MCP error payloads now include a `stack` only when `SYNC_WORKTREES_MCP_DEBUG` is set, not for any `DEBUG` value; `load_config` and `set_current_repository` report `worktreeDir: null` for an auto-detected repository whose directory could not be determined, as `detect_context` does. Tool descriptions and the MCP docs were corrected to match behaviour.
