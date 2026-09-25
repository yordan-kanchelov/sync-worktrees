# sync-worktrees

> Keep every branch checked out. Switching is just `cd`.

[![npm version](https://img.shields.io/npm/v/sync-worktrees)](https://www.npmjs.com/package/sync-worktrees)
[![website](https://img.shields.io/badge/website-sync--worktrees.com-0a7ea4)](https://sync-worktrees.com)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2024-brightgreen)](#install-and-quick-start)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](#install-and-quick-start)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![release](https://github.com/yordan-kanchelov/sync-worktrees/actions/workflows/release.yml/badge.svg)](https://github.com/yordan-kanchelov/sync-worktrees/actions/workflows/release.yml)

sync-worktrees turns each Git branch, in every repository you declare, into a folder on disk and keeps it in sync with
the remote. Git history is stored once per repository; dirty trees are never touched and unpushed commits are never
discarded. A new machine is one config file.

**Contents:** [What you get](#what-you-get) · [Why](#why-sync-worktrees) · [How it works](#how-it-works) ·
[What it will never do](#what-it-will-never-do) · [Install and quick start](#install-and-quick-start) ·
[Configuration](#configuration) · [Interactive TUI](#interactive-tui) · [Optional MCP server](#optional-mcp-server) ·
[CLI reference](#cli-reference) · [Documentation](#documentation) · [Contributing](#contributing) ·
[License](#license)

## What you get

```bash
npm install -g sync-worktrees   # Node 24+, macOS or Linux
sync-worktrees init             # wizard → writes sync-worktrees.config.js
sync-worktrees                  # TUI: syncs now, then hourly; add --runOnce for a one-shot
```

With one repository declared and `init`'s default `worktreeDir` (`./<repo>`), the directory holding the config becomes:

```
.
├── sync-worktrees.config.js
├── .bare/
│   └── my-repo/                   # Git history, stored once
└── my-repo/                       # worktreeDir
    ├── main/                      # the default branch keeps its plain name
    ├── feature-login-df7c7aeb/    # feature/login
    └── feature-2-df15e51b/        # feature-2
```

Every remote branch that passes your filters is a real checkout you can `cd` into, build in and open in an editor.
Folder names come from the branch name: `/` becomes `-`, any other character outside letters, digits, `_` and `-`
becomes `_`, and the stem is capped at 80 characters. The name then ends in eight hex characters of the branch name's
SHA-256, so it is stable and unique per branch. Only the default branch keeps its plain name.

On each sync, a branch that appeared upstream gets a folder, the folder of a branch deleted upstream moves to a
reversible `.trash/`, and folders that are clean and fully pushed are fast-forwarded. The layout is the same on every
machine that runs the same config.

![sync-worktrees demo](./assets/sync-worktrees-demo-optimized.gif)

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

- **Merge, rebase or reset a checkout you are working in.** An existing worktree is fast-forwarded only when it has no
  uncommitted or untracked changes and no unpushed commits; one with unpushed commits is skipped, unless upstream has
  moved too. That is the diverged case below. `updateExistingWorktrees: false` skips the fast-forward phase altogether
  (worktrees are still created and pruned).
- **Remove a worktree that is not clean.** A worktree whose branch is gone upstream (or filtered out) is removed only
  when it has no uncommitted changes, unpushed commits, stashes, in-progress operations, modified submodules or detached
  HEAD. "Removed" means moved to `.trash/`, restorable for 30 days (`trash.enabled: false` deletes it instead).
- **Silently overwrite diverged commits.** If a branch has commits of its own *and* new upstream commits (a force-push,
  or someone else pushed the same branch), the worktree is moved to `.trash/` with its commits pinned (to `.diverged/`
  when trash is disabled) and a fresh checkout of upstream takes its place. When you made no commits since the last
  sync, or your tree already matches upstream, it is reset in place instead. To get the commits back, recover them
  from the trash entry and rebase or cherry-pick them in the fresh checkout. See
  [Diverged branches](./docs/trash-and-recovery.md#diverged-branches-force-pushes).
- **Touch directories outside the paths it manages.** Sync looks only at the worktrees git lists and at the exact path
  where a managed branch's worktree belongs. A directory already sitting at that path that is not a registered worktree
  is treated as stale and moved to `.trash/`. With trash disabled, sync quarantines it in place if it holds a `.git`
  and **deletes it outright** otherwise.
- **Run your hooks unattended.** `hooks.onBranchCreated` and `filesToCopyOnBranchCreate` run only when you create a
  branch from the TUI's wizard, never on a tick or from an agent. The one exception is clone mode, which copies
  `filesToCopyOnBranchCreate` once into the fresh clone; no hook command runs. See
  [Hooks and file copying](./docs/hooks-and-file-copying.md).

Every removal path, its gate, where it goes and how to undo it, including the exceptions (a squash-merged branch, a
diverged worktree that is reset in place, a stash):
[Trash and recovery](./docs/trash-and-recovery.md#what-sync-can-remove).

### What it costs

- **Disk:** one bare repository per entry, one checkout per branch that passes the filters, and whatever `.trash/`
  holds for its 30-day retention (`trash.retentionDays`; set `trash.warnSizeBytes` to be warned when it grows). Each
  checkout is a full working tree unless `sparseCheckout` narrows it, and carries LFS content unless `skipLfs: true`.
  200 live branches × a 300 MB checkout is 60 GB. Bound it with `branchMaxAge`, `branchInclude`/`branchExclude` and
  `sparseCheckout`; the TUI's status bar shows the total.
- **Network:** one `git fetch` per repository per tick (`--all --prune` in worktree mode), plus local status probes.
- **Processes:** up to about 40 concurrent git processes by default, tunable. See
  [Parallelism](./docs/configuration.md#parallelism).

## Install and quick start

Requirements:

- Node.js 24 or newer
- Git; `git-lfs` on any machine syncing a repository that uses LFS (or set `skipLfs: true`)
- macOS or Linux. Windows is not supported: `package.json` declares `os: ["darwin", "linux"]`, so npm refuses the
  install there
- `tmux`, only for the TUI's terminal-open wizard
- An MCP-capable client, only for the optional `sync-worktrees-mcp` server

```bash
npm install -g sync-worktrees
```

The three commands under [What you get](#what-you-get) are the whole setup: `sync-worktrees init` walks you through one
repository and writes `sync-worktrees.config.js` in the current directory (`.mjs`, `.cjs` and `.ts` are also accepted);
to add repositories, edit that file and add entries under `repositories`. See [Configuration](#configuration).

`sync-worktrees` with no arguments opens the [interactive TUI](#interactive-tui), syncs once straight away, then keeps
syncing on the schedule from your config, hourly by default (`defaults.cronSchedule`). Press `q` to quit. To start a
branch, press `c` in the TUI; it creates the folder and pushes. Don't `git checkout -b` inside a managed folder. See
[Team workspace](#team-workspace), step 4.

For a one-shot run (CI, scripts, ad-hoc), add `--runOnce`: it syncs every repository once and exits 0 on success, 1 if
any repository failed (see [Exit codes](#exit-codes)). sync-worktrees sets `GIT_TERMINAL_PROMPT=0` (unless you exported
it yourself), so credentials must come from a credential helper or `ssh-agent`. See
[Authentication](./docs/configuration.md#authentication).

If the config lives elsewhere, pass it explicitly:

```bash
sync-worktrees --config /path/to/sync-worktrees.config.js
sync-worktrees --config /path/to/sync-worktrees.config.js --runOnce
sync-worktrees list --config ./config.js --filter "frontend-*"
```

### Running it unattended

- **Laptop.** Leave the TUI running in a `tmux` or `screen` window. A tick the machine slept through is not replayed;
  the next tick, or `s`, runs the cycle, and `syncOnStart` covers restarts.
- **Build box, no terminal.** There is no headless daemon: without `--runOnce` the TUI is what runs. Put
  `sync-worktrees --runOnce` on a cron line or a systemd/launchd timer instead. Two runs that overlap on one checkout
  do not collide: the second skips that repository and exits 0.
- **Concurrency.** One cross-process lock per checkout; the TUI's ticks, `--runOnce` and the MCP server all contend for
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

Repository settings override `defaults`; the default branch is always kept regardless of filters. Where each setting is
documented:

| Topic                                                                                                | Where                                                                     |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Config formats and discovery, whole-file settings (`runOnce`, `syncOnStart`), repository entries     | [Configuration reference](./docs/configuration.md)                        |
| Branch filtering (`branchInclude`, `branchExclude`, `branchMaxAge`)                                  | [Branch filtering](./docs/configuration.md#branch-filtering)              |
| Credentials for HTTPS and SSH                                                                        | [Authentication](./docs/configuration.md#authentication)                  |
| Retry, LFS, `fetchTimeoutMs`, `cloneTimeoutMs`                                                       | [Retry, LFS and timeouts](./docs/configuration.md#retry-lfs-and-timeouts) |
| Parallelism, maintenance (`git gc`), locking                                                         | [Parallelism](./docs/configuration.md#parallelism) and the sections after |
| One branch at a fixed path; `depth` and the ratcheted fetch cap                                      | [Clone mode](./docs/clone-mode.md)                                        |
| Cone and no-cone patterns, one monorepo under several names, updates outside the sparse set          | [Sparse checkout](./docs/sparse-checkout.md)                              |
| Every removal path, diverged branches, the `.trash/` layout, keep refs, restoring                    | [Trash and recovery](./docs/trash-and-recovery.md)                        |
| `hooks.onBranchCreated`, `filesToCopyOnBranchCreate`, pattern rules, hook timeout and quit semantics | [Hooks and file copying](./docs/hooks-and-file-copying.md)                |
| Every setting, annotated                                                                             | [`sync-worktrees.config.example.js`](./sync-worktrees.config.example.js)  |

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
3. A new hire runs `git clone <workspace> && cd <workspace> && sync-worktrees --runOnce` (or `sync-worktrees` for the
   TUI), and `sync-worktrees list` to confirm what the config resolved to.
4. Start a branch with `c` in the TUI (it creates the folder and pushes), or with `git worktree add` plus a push
   before the next sync. A freshly cut branch that exists only locally has nothing unpushed, so the next tick prunes it
   to `.trash/`; once it carries commits it is kept, but warned about on every tick. Push either way. Don't
   `git checkout -b` inside a managed folder: sync tracks one folder per branch by the branch git reports there, so a
   `main/` switched to another branch stops being `main`, and nothing recreates it.
5. What stays manual: `hooks.onBranchCreated` and `filesToCopyOnBranchCreate` run only for branches created from the
   TUI wizard, so `.env` files and `npm install` for the worktrees the sync creates are still per-worktree steps.

## Interactive TUI

`sync-worktrees` with no arguments opens an Ink-based terminal UI: live logs, a manual sync trigger, wizards for the
common operations, and a status view across every repository.

| Key       | Action                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------- |
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

| Option      | Alias | Description                                                                                                                       | Default |
| ----------- | ----- | --------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--config`  | `-c`  | Path to JavaScript config file (auto-detected in CWD when omitted)                                                                | -       |
| `--runOnce` | -     | Run a sync once and exit, overriding the config's [`runOnce`](./docs/configuration.md#whole-file-settings) for this invocation    | `false` |
| `--help`    | `-h`  | Show help                                                                                                                         | -       |
| `--version` | -     | Print version                                                                                                                     | -       |

Subcommands:

- `sync-worktrees init [--config <path>] [--force]` runs an interactive wizard that writes a minimal config file
  (`./sync-worktrees.config.js` by default). It refuses to overwrite an existing target unless you pass `--force`, and
  it loads the generated file back before reporting success, so a config that would not load fails the command instead
  of surfacing on the next run.
- `sync-worktrees list [--config <path>] [--filter|-f <pattern>]` prints the resolved repositories and exits.
- `sync-worktrees trash` inspects and recovers reversible removals for exactly one worktree-mode repository:

  ```bash
  sync-worktrees trash [--config <path>] [--filter|-f <pattern>] [--json] \
    [--restore <id> | --purge <id> | --dropKeepRef <name> | --dropAllKeepRefs] [--wait]
  ```

  Flags, listing columns and the `--json` shape:
  [The `trash` subcommand](./docs/trash-and-recovery.md#the-trash-subcommand).

### Exit codes

- `sync-worktrees --runOnce` exits **0** when every repository synced, or was skipped because another process held its
  lock (whoever holds it is syncing it) or a clone-mode skip applied. It exits **1** when any repository failed to
  initialize, failed its sync after the retries, recorded a failed action (a rejected sparse pattern, for instance), or
  could not create its lock file at all. Ctrl-C exits **130** after cleanup.
- `sync-worktrees list` exits 1 when `--filter` matches nothing or the config does not load; `sync-worktrees trash`
  exits 1 on an expected failure (unknown id, occupied destination, a lock another process holds, a declined
  confirmation) with one `❌` line.

## Documentation

- [Configuration reference](./docs/configuration.md): config formats and discovery, whole-file settings, repository
  entries, branch filtering, authentication, retry and timeouts, parallelism, maintenance, locking.
- [Clone mode](./docs/clone-mode.md): one branch at a fixed path, plus `depth` and its ratcheted fetch cap.
- [Sparse checkout](./docs/sparse-checkout.md): cone and no-cone patterns, one monorepo under several names, updates
  outside the sparse set.
- [Trash and recovery](./docs/trash-and-recovery.md): every removal path, diverged branches, the `.trash/` layout,
  keep refs, restoring.
- [Hooks and file copying](./docs/hooks-and-file-copying.md): `hooks.onBranchCreated`, `filesToCopyOnBranchCreate`,
  pattern rules, hook timeout and quit semantics.
- [Interactive TUI](./docs/tui.md): every key, the wizards, status flags, terminal and editor launch.
- [MCP server](./docs/mcp.md): install in each client, auto-detect, every tool, safety, parallel agents.
- [`sync-worktrees.config.example.js`](./sync-worktrees.config.example.js): every setting, annotated.
- [CHANGELOG.md](./CHANGELOG.md): what changed in each release.
- [sync-worktrees.com](https://sync-worktrees.com): the landing page, the same FAQ, and
  [llms.txt](https://sync-worktrees.com/llms.txt) / [llms-full.txt](https://sync-worktrees.com/llms-full.txt) for
  agents.

## Contributing

Issues and pull requests are welcome. `pnpm install && pnpm test` runs the unit tests, and
[`pr.yml`](./.github/workflows/pr.yml) checks every PR (lint, format, typecheck, build, smoke test, coverage). A PR that
touches code needs a changeset (`pnpm changeset`); changesets cut the release and write
[CHANGELOG.md](./CHANGELOG.md).

## License

MIT © [Yordan Kanchelov](https://github.com/yordan-kanchelov)
