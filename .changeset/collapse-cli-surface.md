---
"sync-worktrees": major
---

**Breaking**: collapse the CLI to a config-file-only workflow.

`sync-worktrees` now does one thing: load a config file and run it. Every knob (`runOnce`, branch filters, LFS, mode, depth, retry, parallelism, debug, `updateExistingWorktrees`, etc.) lives in the config file.

### Removed CLI flags

`--repoUrl` (`-u`), `--worktreeDir` (`-w`), `--cronSchedule` (`-s`), `--bareRepoDir` (`-b`), `--branchMaxAge` (`-a`), `--branchInclude`, `--branchExclude`, `--skipLfs`, `--no-update-existing`, `--mode`, `--branch`, `--runOnce`, `--debug`, `--sync-on-start`, `--filter` (on the default command), `--list`.

The single-repo flag invocation, the missing-config-file rescue prompt, and the auto-launched interactive setup are all gone.

### New surface

```
sync-worktrees [--config <path>]
sync-worktrees init [--config <path>] [--force]
sync-worktrees list [--config <path>] [--filter <pat>]
```

- `init` writes a new config file (`./sync-worktrees.config.js` by default) and exits. Refuses to overwrite an existing target unless `--force` is passed. Atomic write via `flag: "wx"` — no TOCTOU between check and write.
- `list` is the new home for what used to be `--list`.
- `--filter` only exists on `list` (it's a list-query parameter, not a sync-run override).
- yargs is configured with `camel-case-expansion: false` and `strict()` — typos and removed flags fail loudly.

### Migration

- Replace any single-repo CLI invocation with a config file (run `sync-worktrees init` to generate one).
- Replace `sync-worktrees --list ...` with `sync-worktrees list ...`.
- Move `--runOnce` to `defaults.runOnce: true` in the config file. (Per-repo `runOnce` only suppresses TUI cron scheduling for that one repo — to run the whole CLI as one-shot, set it under `defaults`.)
- Move `--no-update-existing` to `updateExistingWorktrees: false` (per-repo or under `defaults`).
- Move `--debug` to `debug: true` (per-repo or under `defaults`).
- Move `--filter` (sync-run shard targeting) into the config file by maintaining narrower per-environment configs.

### Internals

- New `ConfigFileNotFoundError` typed error in `src/errors`; `loadConfigFile` throws it instead of a stringly-typed `Error`.
- `runSingleRepository`, `reconstructCliCommand`, `isInteractiveMode`, `CliOptions` extras removed.
- `InteractiveUIService.ReloadOptions` removed (the TUI no longer carries CLI overrides).
- `Config` / `RepositoryConfig` types unchanged.
