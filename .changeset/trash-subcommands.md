---
"sync-worktrees": minor
---

`sync-worktrees trash` has subcommands: `trash list` (the default), `trash restore <id>`, `trash purge <id>`, the new `trash purge --all` (every listed entry behind one typed confirmation), `trash drop-keep-ref <name>` and `trash drop-all-keep-refs`. The old flag forms (`trash --restore <id>`, `--purge`, `--drop-keep-ref`, `--drop-all-keep-refs`) keep working and print a one-line hint to the new form on stderr. An empty id or name (`--purge "$ID"` with `$ID` unset) is now rejected instead of falling through to a listing.
