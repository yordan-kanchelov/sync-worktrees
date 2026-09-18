# sync-worktrees documentation

Reference pages for [sync-worktrees](../README.md). The README is the front door; each page here owns one topic in
full.

| Page                                                  | What it covers                                                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Configuration reference](./configuration.md)         | Config formats and discovery, whole-file settings, repository entries, branch filtering, authentication, retry and timeouts, parallelism, maintenance, locking |
| [Clone mode](./clone-mode.md)                         | One branch at a fixed path; `depth` and the ratcheted fetch cap                                                                                    |
| [Sparse checkout](./sparse-checkout.md)               | Cone and no-cone patterns, one monorepo under several names, updates outside the sparse set                                                        |
| [Trash and recovery](./trash-and-recovery.md)         | Every removal path, diverged branches, the `.trash/` layout, keep refs, restoring                                                                  |
| [Hooks and file copying](./hooks-and-file-copying.md) | `hooks.onBranchCreated`, `filesToCopyOnBranchCreate`, pattern rules, hook timeout and quit semantics                                               |
| [Interactive TUI](./tui.md)                           | Every key, the wizards, status flags, terminal and editor launch                                                                                   |
| [MCP server](./mcp.md)                                | Install in each client, auto-detect, every tool, safety, parallel agents                                                                           |

The annotated [example config](../sync-worktrees.config.example.js) shows every knob in place.

Engineering records (not user documentation): [6.0.0-plan.md](./6.0.0-plan.md), [6.0.0-review.md](./6.0.0-review.md),
[FOLLOW-UPS.md](./FOLLOW-UPS.md).
