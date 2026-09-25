---
"sync-worktrees": patch
---

Internal cleanup with a few visible effects:

- MCP `list_worktrees` now says why a worktree's status could not be read (`safeToRemove.reason: "status unavailable: <cause>"`, credentials scrubbed), and `detect_context` with `includeStatus: true` adds a `statusError` field to a worktree whose status probe failed, instead of a bare `unknown` label.
- Worktree-creation failures that roll the worktree back (metadata could not be written, upstream could not be set) are now typed errors, so MCP reports them with their own error codes (`WORKTREE_METADATA_FAILED`, `WORKTREE_UPSTREAM_SETUP_FAILED`) instead of `INTERNAL_ERROR`. Messages are unchanged.
- An invalid `branchMaxAge` and a failed disk-usage total are reported through the repository's logger (the TUI log pane in interactive mode) instead of bare console output written over the interface, and a throwing TUI event listener is reported through the credential-scrubbing logger.
