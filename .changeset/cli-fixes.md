---
"sync-worktrees": minor
---

CLI fixes and output polish:

- `--version` (now also `-V`) prints the build's own version. It used to print `unknown`, or another package's version,
  from a pnpm-installed copy.
- Without a terminal (systemd, docker, CI, `< /dev/null`), `sync-worktrees` without `--runOnce` exits 1 and says to use
  `--runOnce`. It used to print Ink's "Raw mode is not supported" stack trace and exit 0. `sync-worktrees init` also
  exits 1 with a message instead of hanging.
- A failed git command in `--runOnce` is reported as its one `fatal:` line, not about 30 lines of stack and
  `task.commands`. After any failure the run prints a hint that points to `--debug`. The new `--debug` flag turns on
  debug logging and full error details for every repository, overriding the config's `debug`, and keeps doing so after
  the dashboard reloads the config with `r`. A typed failure such as "Cannot fast-forward branch" also carries git's
  one-line reason.
- The bin shim's last-resort error handler now redacts credentials in repository URLs.
- `--runOnce` output: "1 repository" instead of "1 repositories", no empty `[name]` line before each repository header,
  and "Fetching latest data from remote..." printed once per sync instead of twice. Zero skip counts are left out of
  the summary, which also shows the total elapsed time. The "Failed to load config file:" prefix is no longer printed
  twice.
- Colour honours `NO_COLOR` and `FORCE_COLOR`. Log lines have ANSI sequences stripped when stdout is not a terminal.
