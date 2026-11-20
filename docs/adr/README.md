# Architecture decision records

This codebase has no code comments (see [ADR-0001](./0001-record-decisions-in-adrs-not-comments.md)). The non-obvious "why" behind the code lives here, one ADR per subsystem. Entries are grouped by source file and name the symbol they govern, so search this folder for a function or file name to find the reasoning behind it.

To add a decision, append it to the matching subsystem ADR under its file. A new, substantial or reversing decision gets the next free number and its own file; mark the ADR it replaces `Superseded by ADR-NNNN`.

| ADR | Subsystem | Entries | Covers |
| --- | --- | ---: | --- |
| [0001](./0001-record-decisions-in-adrs-not-comments.md) | Record decisions in ADRs, not code comments | | Why there are no comments, the lint rule and its ratchet |
| [0002](./0002-worktree-sync-engine.md) | Worktree-mode sync engine | 213 | Sync planning and running, worktree creation and update, divergence and rebased branches, progress events |
| [0003](./0003-clone-mode.md) | Clone mode | 258 | Clone bootstrap, narrowed refspecs, fetch and deepening, branch switching, fast-forward undo, markers |
| [0004](./0004-trash-and-recovery.md) | Trash and recovery | 301 | Trash entries, payloads, keep refs, the reaper, restore, legacy migration |
| [0005](./0005-concurrency-and-locking.md) | Concurrency and locking | 78 | Repository operation lock, in-process mutexes, scheduling, parallelism budgets |
| [0006](./0006-git-process-execution.md) | Running git | 172 | simple-git clients, timeouts, environment, auth and LFS error parsing, busy probes, retries |
| [0007](./0007-worktree-status.md) | Worktree status | 100 | Clean/dirty, ahead/behind and safety classification of worktrees |
| [0008](./0008-config-and-validation.md) | Configuration and validation | 209 | Config discovery, loading, schema, defaults, inheritance, unknown keys |
| [0009](./0009-tui.md) | Interactive terminal UI | 392 | Ink components, layout budgets, keyboard and mouse input, InteractiveUIService |
| [0010](./0010-mcp-server.md) | MCP server | 186 | Tool handlers, output schemas, context caching, error reporting over stdio |
| [0011](./0011-cli.md) | Command-line interface | 139 | yargs commands and flags, init, doctor, list, trash, dry-run, exit codes |
| [0012](./0012-lfs-and-sparse-checkout.md) | Git LFS and sparse checkout | 105 | LFS verification and skipping, sparse-checkout cone and no-cone modes |
| [0013](./0013-file-copy-and-hooks.md) | File copying and hooks | 62 | Copying untracked files into new worktrees, glob handling, lifecycle hooks |
| [0014](./0014-paths-and-filesystem.md) | Paths and the filesystem | 69 | Path resolution, symlinks, case sensitivity, atomic writes, disk usage |
| [0015](./0015-security-and-redaction.md) | Security and redaction | 55 | Credential redaction in URLs and logs, shell escaping, argument injection |
| [0016](./0016-build-and-tooling.md) | Build and tooling | 41 | esbuild bundle, TypeScript 7 and lint, pnpm, declarations, scripts, CI |
| [0017](./0017-testing-strategy.md) | Testing strategy | 377 | Test infrastructure: real git vs mocks, fixtures, timing, isolation, e2e harness |
