# sync-worktrees

> Keep every branch checked out. Switching is just `cd`.

[![npm version](https://img.shields.io/npm/v/sync-worktrees)](https://www.npmjs.com/package/sync-worktrees)
[![website](https://img.shields.io/badge/website-sync--worktrees.com-0a7ea4)](https://sync-worktrees.com)
[![node](https://img.shields.io/npm/node/v/sync-worktrees)](#install-and-quick-start)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](#install-and-quick-start)
[![license](https://img.shields.io/github/license/yordan-kanchelov/sync-worktrees)](./LICENSE)
[![release](https://github.com/yordan-kanchelov/sync-worktrees/actions/workflows/release.yml/badge.svg)](https://github.com/yordan-kanchelov/sync-worktrees/actions/workflows/release.yml)

sync-worktrees turns each Git branch, in every repository you declare, into a folder on disk and keeps it in sync with
the remote. Git history is stored once per repository; dirty trees are never touched and unpushed commits are never
discarded. A new machine is one config file.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/demo-dark.gif">
  <source media="(prefers-color-scheme: light)" srcset="./assets/demo-light.gif">
  <img alt="Demo: the config, the TUI syncing two repositories, the worktree status view, one folder per branch, then a
    one-shot sync that adds a new upstream branch and moves a deleted one to .trash/"
    src="https://raw.githubusercontent.com/yordan-kanchelov/sync-worktrees/main/assets/demo-dark.gif" width="1000">
</picture>

**Before:** `git stash && git checkout feature/login`, rebuild, and back again later. **After:**
`cd frontend/feature-login`, while every other branch stays checked out and built.

**Contents:** [What you get](#what-you-get) · [Why](#why-sync-worktrees) · [How it works](#how-it-works) ·
[What it will never do](#what-it-will-never-do) · [Install and quick start](#install-and-quick-start) ·
[Configuration](#configuration) · [Interactive TUI](#interactive-tui) · [Optional MCP server](#optional-mcp-server) ·
[CLI reference](#cli-reference) · [Documentation](#documentation) · [Contributing](#contributing) ·
[License](#license)

## What you get

```bash
npm install -g sync-worktrees   # Node 24+, macOS or Linux
sync-worktrees init             # wizard → writes sync-worktrees.config.js
sync-worktrees                  # TUI: syncs now, then hourly; add --run-once for a one-shot
```

With one repository declared and `init`'s default `worktreeDir` (`./<repo>`), the directory holding the config becomes:

```
.
├── sync-worktrees.config.js
├── .bare/
│   └── my-repo/                   # Git history, stored once
└── my-repo/                       # worktreeDir
    ├── main/                      # the default branch
    ├── feature-login/             # feature/login
    └── feature-2/                 # feature-2
```

Every remote branch that passes your filters is a real checkout you can `cd` into, build in and open in an editor.
A folder is named after its branch with `/` turned into `-`; a short hash is appended only when that name would be
ambiguous (two branches that flatten to the same name, names differing only in case, something already in the way)
([naming rules](./docs/configuration.md#worktree-folder-names)).

On each sync, a branch that appeared upstream gets a folder, the folder of a branch deleted upstream moves to a
reversible `.trash/`, and folders that are clean and fully pushed are fast-forwarded. The layout is the same on every
machine that runs the same config.

## Why sync-worktrees

One checkout per repo costs you four things:

- Stashing half-finished work just to check out another branch
- Minutes lost hunting for where you cloned a sibling repo
- Switching branches in five repos because one feature spans them all
- Walking a new hire through a day-one cloning checklist

sync-worktrees removes all four. It keeps **the whole branch and repo layout you work in on disk**: one directory per
branch, kept in sync with the remote. Switching branches becomes `cd`. Searching across repos becomes `grep -r`. A
build, an editor or an AI agent reads the same directories you do.

**Why not plain `git worktree`?** `git worktree add` gives you one directory, by hand. This tool is the script you
would write around it: mirroring the remote's branch set, pruning without deleting someone's uncommitted work,
fast-forwarding only clean trees, doing all of that for twelve repositories from one file, on a schedule.

It also bootstraps a dev environment: one config file describes every repo, branch and folder layout your team works
in. Commit it, and a fresh laptop builds the whole workspace in one command. See [Team workspace](#team-workspace).

### When not to use it

- **One repo, one branch you ever touch.** Plain `git worktree`, or a single clone, is enough.
- **Tiny repos where re-cloning is instant.** The disk and bookkeeping savings don't matter.
- **You don't want many persistent branch directories.** A folder per branch on disk is the design, not an option.

## How it works

The default, **worktree mode**, gives every remote branch its own directory while sharing one Git database:

1. **First run** clones the repository once as a bare repository (`.bare/`: Git data, no working files).
2. **Each sync** fetches, then:
   - creates a directory for every remote branch that passes your filters (`main`, `develop`, `feature/*`, …);
   - fast-forwards existing directories that are clean and fully pushed;
   - moves the directories of branches deleted upstream (or filtered out) to `.trash/`, if they are clean.

The bare repository is the single Git database every worktree attaches to natively, so branches share history for free
(no `--reference`, no alternates). It exists so that no branch is a privileged "main" checkout: every branch, the
default included, is a peer directory.

**Clone mode** (`mode: "clone"`) is a per-repository alternative: a plain `git clone` of one branch into `worktreeDir`,
no bare repo, no per-branch subfolders. Use it when a repo must live at a fixed path, such as a dependency sibling or a
single-branch dev clone. See [Clone mode](./docs/clone-mode.md).

### What it will never do

- **Merge, rebase or reset a checkout you are working in:** only clean, fully pushed worktrees are fast-forwarded.
- **Remove a worktree that is not clean:** a gone branch's folder moves to a restorable `.trash/`, and only if clean.
- **Silently overwrite diverged commits:** they are pinned in `.trash/` before a fresh checkout takes the folder
  ([Diverged branches](./docs/trash-and-recovery.md#diverged-branches-force-pushes)).
- **Touch directories outside the paths it manages:** only registered worktrees and each branch's own folder path.
- **Run your hooks unattended:** hooks run only for branches you create in the TUI
  ([Hooks and file copying](./docs/hooks-and-file-copying.md)).

Every removal path, its gate, where it goes and how to undo it, including the exceptions:
[Trash and recovery](./docs/trash-and-recovery.md#what-sync-can-remove).

### What it costs

- **Disk:** a full checkout per branch plus 30 days of `.trash/` (200 branches × 300 MB is 60 GB); bound it with
  [filters](./docs/configuration.md#branch-filtering) and [sparse checkout](./docs/sparse-checkout.md).
- **Network:** one `git fetch` per repository per tick.
- **Processes:** up to about 40 concurrent git processes by default
  ([Parallelism](./docs/configuration.md#parallelism)).

## Install and quick start

Requirements:

- Node.js 24 or newer. npm only warns when installing on an older Node; both commands then print a warning at start-up
  and carry on, untested. On Node 22, `sync-worktrees@5` is the supported line
- Git; `git-lfs` on any machine syncing a repository that uses LFS (or set `skipLfs: true`)
- macOS or Linux. Windows is not supported: `package.json` declares `os: ["darwin", "linux"]`, so npm refuses the
  install there
- `tmux`, only for the TUI's terminal-open wizard
- An MCP-capable client, only for the optional `sync-worktrees-mcp` server

The three commands under [What you get](#what-you-get) are the whole setup: `sync-worktrees init` walks you through one
repository and writes `sync-worktrees.config.js` in the current directory (`.mjs`, `.cjs` and `.ts` are also accepted);
to add repositories, edit that file and add entries under `repositories`. See [Configuration](#configuration).
`sync-worktrees doctor` then checks the whole setup (git, the config, each remote's credentials, the directories)
before the first sync.

`sync-worktrees` with no arguments opens the [interactive TUI](#interactive-tui), syncs once straight away, then keeps
syncing on the schedule from your config, hourly by default (`defaults.cronSchedule`). Press `q` to quit. To start a
branch, press `c` in the TUI; it creates the folder and pushes. Don't `git checkout -b` inside a managed folder. See
[Team workspace](#team-workspace), step 4.

For a one-shot run (CI, scripts, ad-hoc), add `--run-once`: it syncs every repository once and exits 0 on success, 1 if
any repository failed (see [Exit codes](#exit-codes)). sync-worktrees sets `GIT_TERMINAL_PROMPT=0` (unless you exported
it yourself), so credentials must come from a credential helper or `ssh-agent`. See
[Authentication](./docs/configuration.md#authentication).

Without `--config`, `sync-worktrees`, `list` and `trash` use `$SYNC_WORKTREES_CONFIG` when it is set, and otherwise
the nearest `sync-worktrees.config.{js,mjs,cjs,ts}` in the current directory or a parent, the way git finds `.git`.
The walk stops at your home directory when it starts inside it. `sync-worktrees` and `list` print the file they used.
If the config lives elsewhere, pass it explicitly:

```bash
sync-worktrees --config /path/to/sync-worktrees.config.js
sync-worktrees --config /path/to/sync-worktrees.config.js --run-once
sync-worktrees --run-once --filter backend     # just the repositories the filter matches
sync-worktrees --dry-run --filter backend      # what that sync would do, without doing it
sync-worktrees list --config ./config.js --filter "frontend-*"
```

`--dry-run` prints, per repository, the worktrees a sync would create, fast-forward, prune (and why it is safe to),
replace after a divergence, and skip (and why), then exits without changing anything. It does fetch, so the plan
matches origin now: remote-tracking refs move as they would with `git fetch`. `--json` prints the plans as JSON. See
[Previewing a sync](./docs/dry-run.md).

### Running it unattended

- **Laptop.** Leave the TUI running in a `tmux` or `screen` window. A tick the machine slept through is not replayed;
  the next tick, or `s`, runs the cycle, and `syncOnStart` covers restarts.
- **Build box, no terminal.** There is no headless daemon: without `--run-once` the TUI is what runs, and when stdin
  or stdout is not a terminal (piping through `tee` included) it refuses to start and exits 1. Put
  `sync-worktrees --run-once --quiet` on a cron line or a systemd/launchd timer instead; `--quiet` cuts a clean run to
  its one summary line instead of a few dozen. Cron still mails that line; warnings and errors go to stderr, so
  `sync-worktrees --run-once --quiet >/dev/null` mails only when something needs attention. Two runs that overlap on
  one checkout do not collide: the second skips that repository and exits 0.
- **Concurrency.** One cross-process lock per checkout; the TUI's ticks, `--run-once` and the MCP server all contend for
  it, and the loser skips and says so. See [Locking](./docs/configuration.md#locking).

## Configuration

The config is a JavaScript module (`init` picks ES module or CommonJS for you; `.ts` works too). Relative paths resolve
from the file's location, `process.env` is available, and the `@satisfies` annotation type-checks it in your editor. A
realistic multi-repo file:

```javascript
// sync-worktrees.config.js
// @ts-check

/** @satisfies {import("sync-worktrees").SyncWorktreesConfig} */
const config = {
  defaults: {
    cronSchedule: "0 * * * *", // hourly (the default)
    branchMaxAge: "30d", // skip branches with no commit in 30 days
    branchExclude: ["wip-*", "tmp-*"],
  },

  repositories: [
    {
      name: "frontend",
      repoUrl: "https://github.com/company/frontend.git",
      worktreeDir: "./worktrees/frontend",
      cronSchedule: "*/30 * * * *", // per-repo override
    },
    {
      name: "backend",
      repoUrl: process.env.BACKEND_REPO_URL || "https://github.com/company/backend.git",
      worktreeDir: "./worktrees/backend",
      branchMaxAge: "6m",
      branchInclude: ["feature/*", "release-*", "main"],
    },
  ],
};

export default config;
```

Repository settings override `defaults`; the default branch is always kept regardless of filters. Every setting is
annotated in [`sync-worktrees.config.example.js`](./sync-worktrees.config.example.js) and explained in the
[documentation](./docs/README.md).

### Team workspace

Onboarding, step by step:

1. Keep `sync-worktrees.config.js` in a small workspace repository of its own. Use relative `worktreeDir`s (they resolve
   from the config file) or `path.join(os.homedir(), …)`, so the file is portable across home directories. Add a
   `.gitignore` that keeps only the config. Three lines do it: `*`, `!.gitignore`, `!sync-worktrees.config.js`.
   Everything the tool writes lands beside that file: `.bare/`, the worktree folders (each with its own `.trash/`),
   `.sync-worktrees-state/` and `.sync-worktrees-locks/`.
2. Keep credentials out of it: HTTPS through a credential helper, SSH through `ssh-agent`
   ([Authentication](./docs/configuration.md#authentication)); a private URL can come from `process.env`. URLs that do
   carry a token are redacted in logs and in `sync-worktrees list` output.
3. A new hire runs `git clone <workspace> && cd <workspace> && sync-worktrees --run-once` (or `sync-worktrees` for the
   TUI), and `sync-worktrees list` to confirm what the config resolved to.
4. Start a branch with `c` in the TUI (it creates the folder and pushes), or with `git worktree add` plus a push
   before the next sync. A freshly cut branch that exists only locally has nothing unpushed, so the next tick prunes it
   to `.trash/`; once it carries commits it is kept, but warned about on every tick. Push either way. Don't
   `git checkout -b` inside a managed folder: sync tracks one folder per branch by the branch git reports there, so a
   `main/` switched to another branch stops being `main`, and nothing recreates it.
5. What stays manual: `hooks.onBranchCreated` and `filesToCopyOnBranchCreate` run only for branches created from the
   TUI wizard, so `.env` files and `npm install` for the worktrees the sync creates are still per-worktree steps.

## Interactive TUI

`sync-worktrees` with no arguments opens an Ink-based terminal UI. Its home screen is a table with one row per
repository (state, last result, how long ago it synced, worktrees, dirty/unpushed counts, next run) above the live log,
which `l` folds to one line and `+` / `-` resize. It also has a manual sync trigger, wizards for the common operations,
and a status view across every repository.

| Key       | Action                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| `/`       | Jump to any worktree in any repository (fuzzy switcher); `Enter` opens it, `Tab` for more actions               |
| `s`       | Sync all repositories now                                                                                       |
| `c`       | Create a branch (wizard: repo, base branch, name)                                                               |
| `o`       | Open a worktree in a terminal (`tmux`) or a GUI editor                                                          |
| `w`       | Worktree status across repos, with flags per worktree                                                           |
| `x`       | [Force clean](./docs/trash-and-recovery.md#force-clean-from-the-tui-x): purge trash and recovery refs, `git gc` |
| `r`       | Reload the config and re-sync                                                                                   |
| `?` / `h` | Help                                                                                                            |
| `q`       | Quit; asks first while a sync or hook is running (`Esc` only backs out of what is open)                         |

Every key, the wizards, the status flags, and the terminal/editor launch variables: [Interactive TUI](./docs/tui.md).

## Optional MCP server

A second binary, `sync-worktrees-mcp`, speaks the [Model Context Protocol](https://modelcontextprotocol.io) over stdio
for clients that want it (Claude Code, Cursor, Claude Desktop, VS Code, Codex, …). The folders are ordinary directories
either way. The standard config, which works in most clients:

```json
{
  "mcpServers": {
    "sync-worktrees": {
      "command": "npx",
      "args": ["-y", "-p", "sync-worktrees", "sync-worktrees-mcp"]
    }
  }
}
```

Claude Code: `claude mcp add --scope user sync-worktrees -- npx -y -p sync-worktrees sync-worktrees-mcp` (`--scope user`
makes it available in every worktree; the default scope is per directory). No config path is needed: the server walks up
from the client's working directory to find your config and the worktree it was launched in. Nine tools:
`detect_context`, `list_worktrees`, `get_worktree_status`, `create_worktree`, `update_worktree`, `sync`, `initialize`,
`load_config`, `set_current_repository`.

What an agent cannot do through it:

- **Delete, trash, restore or purge anything directly.** The only removal paths are `sync`'s own: the same prune,
  stale-directory sweep and diverged replace the CLI runs, with the same gates and destinations (`.trash/` by default;
  with `trash.enabled: false` a prune is permanent and a diverged worktree goes to `.diverged/` instead). `sync` is
  flagged destructive, so clients can prompt.
- **Move an existing remote branch.** Pushes are create-only.
- **Overwrite an existing directory.**
- **Create a branch your filters would prune again**, unless it passes `force: true`, which the response then warns
  about.

Setup for every client, what the server sees from where it is launched, the full tool table, safety in detail, and a
recipe for parallel agents on parallel branches: [MCP server](./docs/mcp.md).

## CLI reference

| Option       | Alias | Description                                                                                                                    | Default |
| ------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `--config`   | `-c`  | Config file path. When omitted: `$SYNC_WORKTREES_CONFIG`, else the nearest config in this directory or a parent (up to `~`)    | -       |
| `--run-once` | -     | Run a sync once and exit, overriding the config's [`runOnce`](./docs/configuration.md#whole-file-settings) for this invocation | `false` |
| `--debug`    | -     | Log debug output and full error details (stack, git's whole output), overriding the config's `debug`                           | `false` |
| `--filter`   | `-f`  | Only sync repositories whose name matches (wildcards, comma-separated; same matching as `list`). Exits 1 if nothing matches    | -       |
| `--quiet`    | `-q`  | One-shot runs: print only warnings, errors and the final summary line (the TUI ignores it)                                     | `false` |
| `--dry-run`  | -     | Print what a sync would do and exit without changing anything except remote-tracking refs; see [Previewing a sync](./docs/dry-run.md) | `false` |
| `--json`     | -     | With `--dry-run`: print the plans as a JSON array                                                                              | `false` |
| `--help`     | `-h`  | Show help                                                                                                                      | -       |
| `--version`  | `-V`  | Print version                                                                                                                  | -       |

Flags are kebab-case; the camelCase spellings from earlier releases (`--runOnce`, `--dropKeepRef`, `--dropAllKeepRefs`)
keep working. `sync-worktrees sync` is an explicit name for the default command, and a mistyped command or flag gets a
"did you mean" hint.

A failed git command is reported as its one `fatal:` line; `--debug` (or `debug: true`) prints everything. Colour
follows [`NO_COLOR`](https://no-color.org) and `FORCE_COLOR`, and is stripped from log lines when stdout is not a
terminal.

Subcommands:

- `sync-worktrees init [--config <path>] [--force]` runs an interactive wizard that writes a minimal config file
  (`./sync-worktrees.config.js` by default). It refuses to overwrite an existing target unless you pass `--force`, and
  it loads the generated file back before reporting success, so a config that would not load fails the command instead
  of surfacing on the next run.
- `sync-worktrees list [--config <path>] [--filter|-f <pattern>] [--json]` prints the resolved repositories, with what
  is on disk for each (registered worktrees and trash entries; for a clone, whether it exists yet), and exits. It only
  reads (`git worktree list` and the `.trash` directory) and takes no lock, so it is safe next to a running sync.
  `--json` prints an array instead, one object per repository:

  ```json
  {
    "name": "app",
    "mode": "worktree",
    "repoUrl": "https://***@github.com/org/app.git",
    "worktreeDir": "/home/me/code/app",
    "bareRepoDir": "/home/me/code/.bare/app",
    "branch": null,
    "schedule": "0 * * * *",
    "runOnce": false,
    "skipLfs": false,
    "filters": { "branchInclude": null, "branchExclude": ["dependabot/*"], "branchMaxAge": "14d" },
    "sparseCheckout": null,
    "counts": { "worktrees": 4, "trashEntries": 1, "error": null }
  }
  ```

  Every key is always present. `repoUrl` has credentials removed. `bareRepoDir` is `null` in clone mode and `branch`
  outside it. `sparseCheckout` is `{ include, exclude, mode, skipUpdateWhenOutsideSparse }` with defaults filled in.
  `counts.worktrees` counts registered worktrees whose directory exists (in clone mode, 1 once the clone exists).
  `counts.trashEntries` is `null` in clone mode, which has no trash. Both are `null` when they could not be read, and
  `counts.error` then says why.
- `sync-worktrees doctor [--config <path>] [--filter|-f <pattern>] [--json] [--quiet]` checks the setup without
  changing anything: Node and git versions, git-lfs, the config file, and for each repository whether `repoUrl` answers
  a non-interactive `git ls-remote`, whether its directories and lock/state directories are writable, and free disk
  space. One `PASS`/`WARN`/`FAIL` line per check with a fix hint; see [Checking your setup](./docs/doctor.md).
- `sync-worktrees trash` inspects and recovers reversible removals for exactly one worktree-mode repository:

  ```bash
  sync-worktrees trash [list] [--json]            # the default
  sync-worktrees trash restore <id> [--wait]
  sync-worktrees trash purge <id> [--wait]        # or: purge --all
  sync-worktrees trash drop-keep-ref <name>
  sync-worktrees trash drop-all-keep-refs
  ```

  Each takes `--config <path>` and `--filter|-f <pattern>`. The older flag forms (`trash --restore <id>`, `--purge`,
  `--drop-keep-ref`, `--drop-all-keep-refs`) still work and print a one-line hint to the subcommand. Listing columns,
  confirmations and the `--json` shape:
  [The `trash` subcommand](./docs/trash-and-recovery.md#the-trash-subcommand).

- `sync-worktrees completion` prints a bash/zsh completion script for commands and flags:

  ```bash
  sync-worktrees completion >> ~/.bashrc   # or ~/.zshrc
  ```

### Exit codes

- `sync-worktrees --run-once` exits **0** when every repository synced, or was skipped because another process held its
  lock (whoever holds it is syncing it) or a clone-mode skip applied. It exits **1** when any repository failed to
  initialize, failed its sync after the retries, recorded a failed action (a rejected sparse pattern, for instance), or
  could not create its lock file at all. Ctrl-C exits **130** after cleanup.
- `sync-worktrees` without `--run-once`, and `sync-worktrees init`, exit **1** with a one-line explanation when stdin
  or stdout is not a terminal (systemd, docker, CI, `< /dev/null`).
- `sync-worktrees list` and `sync-worktrees --filter` exit 1 when `--filter` matches nothing or the config does not
  load; `sync-worktrees trash` exits 1 on an expected failure (unknown id, occupied destination, a lock another process
  holds, a declined confirmation) with one `❌` line.
- `sync-worktrees doctor` exits 1 when any check failed; warnings alone exit 0.
- `sync-worktrees --dry-run` exits 1 when any repository could not be planned; what the plan contains never changes it.

## Documentation

- [docs/](./docs/README.md): one reference page per topic: configuration, clone mode, sparse checkout, trash and
  recovery, hooks and file copying, the TUI, the MCP server.
- [`sync-worktrees.config.example.js`](./sync-worktrees.config.example.js): every setting, annotated.
- [CHANGELOG.md](./CHANGELOG.md): what changed in each release.
- [sync-worktrees.com](https://sync-worktrees.com): the landing page, the same FAQ, and
  [llms.txt](https://sync-worktrees.com/llms.txt) / [llms-full.txt](https://sync-worktrees.com/llms-full.txt) for
  agents.

## Contributing

Issues and pull requests are welcome. After `pnpm install`:

- `pnpm test:unit` runs the unit tests. It needs no build.
- `pnpm test:e2e` builds the CLI and runs the end-to-end suites against `dist/`. `pnpm test:e2e:network` adds the cases
  that clone from GitHub; [`nightly.yml`](./.github/workflows/nightly.yml) runs those daily on Linux and macOS.
- `pnpm test` runs both, but does not build: run `pnpm build` first, or the end-to-end suites fail.

[`pr.yml`](./.github/workflows/pr.yml) checks every PR (lint, format, typecheck, build, smoke test, tests with a coverage
summary on the run page). A PR that touches code needs a changeset (`pnpm changeset`); changesets cut the release and
write [CHANGELOG.md](./CHANGELOG.md).

## License

MIT © [Yordan Kanchelov](https://github.com/yordan-kanchelov)
