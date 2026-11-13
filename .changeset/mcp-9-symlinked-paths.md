---
"sync-worktrees": patch
---

MCP tools now resolve symlinks in caller-supplied paths and in the loaded config's `bareRepoDir`/`worktreeDir`. Through a symlinked directory (all of `/tmp` and `/var` on macOS), `detect_context` used to report no current worktree and list a config's own repository as an unmanaged sibling, and `get_worktree_status`/`update_worktree` answered "not a registered worktree".
