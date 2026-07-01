---
"sync-worktrees": patch
---

Document the clone vs worktree repo-mode distinction in the MCP server instructions.

The two modes previously surfaced only as an output discriminator in `detect_context`'s schema, so agents had to guess what the modes meant and whether tool behavior differed. The server `instructions` string now defines both modes and notes that `create_worktree`/`update_worktree` are worktree-mode only. Those two tool descriptions gain a matching clause, and `sync`'s cross-references are qualified to worktree mode (they pointed at tools that error in clone mode).
