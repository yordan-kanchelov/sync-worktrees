---
"sync-worktrees": patch
---

Internal polish follow-up to the CLI collapse refactor:

- Extract `fileExists()` helper, dedupe 8 inline `fs.access` existence checks across config + status paths.
- Replace `InitConfigInput` interface with `Pick<RepositoryConfig, ...>` so init wizard input type auto-tracks `RepositoryConfig`.
- Add `CLI_COMMANDS` const + discriminated `CliOptions` union; `main()` now uses `switch` with exhaustive `never` guard so future commands fail at compile time.
- Collapse `runMultipleRepositories` signature — takes the loaded `ConfigFile` directly and derives `runOnce` / `maxParallel` internally.
- Multi-repo runner already sets `process.exitCode = 1` on any init/sync failure (shipped in the parent PR).
