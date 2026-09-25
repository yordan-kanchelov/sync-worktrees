---
"sync-worktrees": minor
---

CLI ergonomics:

- Flags are kebab-case in `--help` and the docs (`--run-once`, `--drop-keep-ref`, `--drop-all-keep-refs`); the camelCase
  spellings keep working.
- `sync-worktrees --filter <pattern>` (`-f`) syncs only the repositories the pattern matches, with the same matching as
  `list`, and exits 1 when nothing matches. The interactive UI keeps the filter across config reloads.
- `-q`/`--quiet` limits a one-shot run to warnings, errors and the final summary line, so a clean run prints one line
  instead of a few dozen. Warnings and errors go to stderr, so `--run-once --quiet >/dev/null` in cron mails only when
  something needs attention.
- `sync-worktrees completion` prints a bash/zsh completion script.
- A mistyped command or flag gets a "did you mean" hint, `sync` is an explicit name for the default command, and
  `--help` now carries examples and a link to the docs.
