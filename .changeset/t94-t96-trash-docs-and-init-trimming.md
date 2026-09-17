---
"sync-worktrees": patch
---

`sync-worktrees init` now trims the answers it stores, and the README documents the `trash` subcommand.

**The init wizard stored answers it had only validated in trimmed form.** Every validator in the wizard tests `value.trim()`; the raw string is what was saved. `path` never normalizes trailing whitespace away — `path.resolve("./wt ")` is `<cwd>/wt ` — so an answer that validated as `./wt` was stored, written into the generated config and later created on disk as a directory one character away from the one the person typed. `repoUrl`, `worktreeDir`, `bareRepoDir` and `cronSchedule` are now trimmed as they come back, which is what `branch` and `depth` already did at their point of use.

The cron answer was the one case that failed outright rather than quietly. `cron.validate` accepts a space-padded expression but rejects every other kind of whitespace, while `trim()` removes them all, so an answer carrying a tab or a non-breaking space — what pasting one out of a crontab or a rendered documentation page gives you — passed the prompt and was written into the config. `init`'s own round-trip load then refused the file it had just written with `Invalid cron expression in defaults`, exited 1, and left the broken config on disk.

Two guards were reading a different string from the one they were protecting. The worktree-mode check that refuses the config file's own directory as `worktreeDir` compared the *trimmed* answer against the config directory and then stored the untrimmed one, so the path it approved was not the path it saved. The clone-mode warning — the one line telling you `git clone` will refuse a destination that exists and is not empty — compared the untrimmed answer, so it stayed silent for a pasted path carrying a trailing space. Both now see the value that is actually stored.

The URL prompt also stops rejecting whitespace it would have trimmed: its shape check was the one validator reading the raw value, so a leading space (the usual artefact of pasting) was reported as "Please enter a valid Git URL". Something that is not a URL once trimmed is still rejected with the same message.

**README's CLI reference lists `trash`.** The Subcommands list has carried `init` and `list` since before the trash CLI existed in 5.2.0, so the reference a reader consults for "what can this command do" did not mention the only way to inspect or recover a reversible removal, and `sync-worktrees --help` was the only place it appeared. The new entry documents every flag the command accepts today — `--config`, `--filter`, `--restore`, `--purge`, `--dropKeepRef`, `--dropAllKeepRefs`, `--json` and `--wait` — along with the constraints that decide whether an invocation is accepted at all: exactly one matched repository, worktree mode only, the four mutually exclusive operations, and the three that need an interactive TTY and a typed confirmation.

`patch` rather than `minor`: no option, subcommand or exported type is added, and nothing that loaded before loads differently. The behaviour change is confined to `init`, which now saves the string it validated.
