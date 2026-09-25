# Checking your setup: `sync-worktrees doctor`

`sync-worktrees doctor` checks everything a sync depends on and prints one line per check, marked `PASS`, `WARN` or
`FAIL`, with a hint under each warning and failure. It changes nothing: it creates no directory, clones nothing and takes
no lock, so it is safe to run next to a running TUI or a cron job.

```bash
sync-worktrees doctor                          # the config found as for every command
sync-worktrees doctor --config ./sync.config.js --filter "backend-*"
sync-worktrees doctor --quiet                  # only warnings, failures and the summary line
sync-worktrees doctor --json | jq '.[] | select(.status != "pass")'
```

| Option       | Alias | Description                                                                      |
| ------------ | ----- | -------------------------------------------------------------------------------- |
| `--config`   | `-c`  | Config file to check (default lookup: [Configuration](./configuration.md))       |
| `--filter`   | `-f`  | Only check repositories whose name matches (wildcards, comma-separated)         |
| `--json`     | -     | Print the checks as one JSON array instead of the report (`--quiet` is ignored) |
| `--quiet`    | `-q`  | Print only warnings, failures and the summary line                              |

## What it checks

| Check           | Scope          | Passes when                                                                                                                  |
| --------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `node`          | machine        | Node.js meets `engines.node` in package.json (24 or newer). An older Node is a warning, as at start-up: it runs, untested     |
| `git`           | machine        | `git --version` runs and reports 2.36 or newer. Older is a warning: worktree listings fall back to a newline-separated format |
| `git-lfs`       | machine        | `git lfs version` runs, or no already-synced repository declares LFS files (`filter=lfs` in HEAD's `.gitattributes`)          |
| `config`        | machine        | The config file is found (its path is printed), loads and validates, and `--filter` matches at least one repository          |
| `remote`        | per repository | `git ls-remote --heads <repoUrl>` succeeds within 15 seconds, without any prompt                                              |
| `worktree-dir`  | per repository | `worktreeDir` is a writable directory, or its nearest existing parent is writable so a sync can create it                    |
| `bare-repo-dir` | per repository | The same for `bareRepoDir` (worktree mode only)                                                                              |
| `disk-space`    | per repository | At least 1 GiB is free where `worktreeDir` and `bareRepoDir` live. Under 1 GiB is a warning, under 100 MiB a failure          |
| `lock-dir`      | per repository | The [lock directory](./configuration.md#locking) (`SYNC_WORKTREES_LOCK_DIR`, or next to `worktreeDir`) can be written        |
| `state-dir`     | per repository | The state directory for the removal audit log (`.sync-worktrees-state/` next to the config file) can be written               |

When git cannot run at all, only `node`, `git` and `config` are reported: every other check needs git.

The remote check runs git with `GIT_TERMINAL_PROMPT=0` (even when you exported it) and without a controlling terminal,
so neither git nor ssh can stop to ask for a password, a key passphrase or a host-key confirmation. That is how the
sync itself runs, so a remote that passes here authenticates the same way during a sync; a failure carries the same
hint the sync would print (credential helper, `ssh-agent`, `known_hosts`). Credentials in a `repoUrl` are redacted in
every line, JSON included.

## Exit code and JSON

`doctor` exits **0** when no check failed and **1** when any did. Warnings never fail it, so
`sync-worktrees doctor --quiet` fits in a provisioning script or a CI step.

`--json` prints a single array, one object per check, in the same order as the report:

```json
[
  {
    "check": "remote",
    "repository": "backend",
    "status": "fail",
    "message": "https://***@github.com/acme/backend.git is not reachable: fatal: Authentication failed for '…'",
    "hint": "sync-worktrees runs git non-interactively (GIT_TERMINAL_PROMPT=0) and cannot answer a credential prompt: …"
  }
]
```

`repository` is `null` for the machine-wide checks, and `hint` is `null` when there is nothing to do. Colour in the
report follows [`NO_COLOR`](https://no-color.org) and `FORCE_COLOR`, like the rest of the CLI; the JSON never carries
any.
