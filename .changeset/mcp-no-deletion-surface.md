---
"sync-worktrees": major
---

Remove all deletion capabilities from the MCP server.

The agent-facing MCP surface no longer exposes any destructive or trash operations: the `remove_worktree` tool is removed (breaking — it shipped in earlier releases), and the unreleased `list_trash` / `restore_trash` tools and the per-repo trash summary on `list_worktrees` are dropped before ever shipping. The `removeWorktree` capability key disappears from `detect_context` responses.

Rationale: the MCP server is consumed by AI agents, and an agent-facing API should not carry irreversible affordances — a hallucinated call or prompt-injected instruction must not be able to destroy work. Escalation may bypass preconditions, never recoverability. Worktree removal remains available through sync's safety-gated pruning (trash-backed, restorable) and manual git commands; trash inspection and restore are human operations driven by each entry's `manifest.json`.
