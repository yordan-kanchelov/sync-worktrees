# sync-worktrees documentation

Reference pages for [sync-worktrees](../README.md). The README is the front door; each page here owns one topic in
full.

| Page                                                     | What it covers                                                                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [Configuration reference](./configuration.md)            | File formats and discovery, whole-file settings, repository entries, branch filtering, authentication, retry, LFS, timeouts, parallelism, maintenance, locking |
| [Clone mode](./clone-mode.md)                            | One branch at a fixed path, `depth` and the ratcheted fetch cap, with the measurements behind the rule                     |
| [Sparse checkout](./sparse-checkout.md)                  | Cone and no-cone patterns, duplicate `repoUrl` layouts, updates outside the sparse set, narrowing safety                     |
| [Trash and recovery](./trash-and-recovery.md)            | Every path by which sync removes something, diverged branches, `.trash/` layout, pin and keep refs, the `trash` subcommand |
| [Hooks and file copying](./hooks-and-file-copying.md)    | `hooks.onBranchCreated`, `filesToCopyOnBranchCreate`, pattern rules, hook environment and timeout, quit semantics           |
| [Interactive TUI](./tui.md)                              | Every key, the wizards, status flags, terminal and editor launch                                                             |
| [MCP server](./mcp.md)                                   | Install in each client, auto-detect, every tool, safety, running parallel agents                                             |

The annotated [example config](../sync-worktrees.config.example.js) shows every knob in place.

Engineering records (not user documentation): [6.0.0-plan.md](./6.0.0-plan.md), [6.0.0-review.md](./6.0.0-review.md),
[FOLLOW-UPS.md](./FOLLOW-UPS.md).
