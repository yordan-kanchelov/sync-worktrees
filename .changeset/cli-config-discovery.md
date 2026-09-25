---
"sync-worktrees": minor
---

**The CLI finds its config from a subdirectory, honours `SYNC_WORKTREES_CONFIG`, and `list` gains `--json` and on-disk counts.**

- **Config discovery walks up.** Without `--config`, `sync-worktrees`, `list` and `trash` used to look for `sync-worktrees.config.{js,mjs,cjs,ts}` in the current directory only, so running them from inside a worktree or any subdirectory failed with "No config file found". They now walk up from the current directory to the first directory that has one, the way git finds `.git`. When the walk starts inside your home directory it stops there: a config in `~` is found, one in `/home` or `/` is not.
- **`SYNC_WORKTREES_CONFIG`.** The CLI reads this variable when `--config` is not given. The order is `--config`, then the variable, then discovery. A relative value resolves against the current directory, an empty one counts as unset, and a path that does not exist fails with a message naming the variable rather than falling through to discovery. The MCP server still ignores the variable, as it has since 7.0.0.
- **Which file was used.** The `📄 Using config:` line from `sync-worktrees` (and now `list`) says when the file came from a parent directory or from the variable. `trash` prints the same line on stderr whenever the path did not come from `--config`, so its tab-separated and JSON output are unchanged.
- **`list --json`** prints an array with one object per repository: `name`, `mode`, `repoUrl` (credentials removed), `worktreeDir`, `bareRepoDir`, `branch`, `schedule`, `runOnce`, `skipLfs`, `filters` (`branchInclude`, `branchExclude`, `branchMaxAge`), `sparseCheckout` (with defaults filled in) and `counts`. Every key is always present, with `null` when it does not apply. Failures go to stderr with exit 1, so stdout is never half a document.
- **On-disk counts.** `list` now shows, for each repository, the registered worktrees whose directory exists and the entries in its trash (for a clone-mode repository, whether the clone exists yet). It only reads `git worktree list` and the `.trash` directory and takes no lock, so it is safe to run next to a sync. A count that cannot be read is shown as unknown, with the reason, instead of as zero.
- The human `list` output also gains `Mode`, `Branch` (clone mode), `Branch filters` and `Sparse checkout` lines.
