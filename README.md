# sync-worktrees

> Keep every branch checked out. Switching is just `cd`.

[![npm version](https://img.shields.io/npm/v/sync-worktrees)](https://www.npmjs.com/package/sync-worktrees)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2024-brightgreen)](#install-and-quick-start)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](#requirements)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

sync-worktrees turns each Git branch, in every repository you declare, into a folder on disk and keeps it in sync with
the remote. Git history is stored once per repository; dirty trees and unpushed commits are left alone. A new machine is
one config file.

![sync-worktrees demo](./assets/sync-worktrees-demo-optimized.gif)

**Contents:** [What you get](#what-you-get) · [Why](#why-sync-worktrees) · [How it works](#how-it-works) ·
[What it will never do](#what-it-will-never-do) · [Install and quick start](#install-and-quick-start) ·
[Configuration](#configuration) · [Interactive TUI](#interactive-tui) · [Optional MCP server](#optional-mcp-server) ·
[CLI reference](#cli-reference) · [Documentation](#documentation) · [Requirements](#requirements) ·
[Contributing](#contributing) · [License](#license)

## What you get

```bash
npm install -g sync-worktrees   # Node 24+, macOS or Linux
sync-worktrees init             # wizard → writes sync-worktrees.config.js
sync-worktrees                  # TUI: syncs now, then hourly; add --runOnce for a one-shot
```

With one repository declared, the directory holding the config becomes:

```
.
├── sync-worktrees.config.js
├── .bare/
│   └── my-repo/             # Git history, stored once
└── worktrees/my-repo/
    ├── main/                # a checkout of main
    ├── feature-1/           # a checkout of feature-1
    └── feature-2/           # a checkout of feature-2
```

Every remote branch that passes your filters is a real checkout you can `cd` into, build in and open in an editor. A
branch that appears upstream gets a folder on the next sync; a branch deleted upstream has its folder moved to a
reversible `.trash/`; clean, fully pushed folders are fast-forwarded. The layout is the same on every machine that runs
the same config.

## Why sync-worktrees

If you've ever:

- Stashed half-finished work just to check out another branch
- Lost minutes hunting for where you cloned a sibling repo
- Switched branches in five repos because one feature spans them all
- Walked a new hire through a day-one cloning checklist

…sync-worktrees removes that. It keeps the **entire branch and repo layout you work in materialized on disk** — one
directory per branch, kept in sync with the remote. Switching branches becomes `cd`. Searching across repos becomes
`grep -r`. Anything that reads a directory — a build, an editor, an AI agent — sees the same shape you do.

**Why not plain `git worktree`?** `git worktree add` gives you one directory, by hand. What you would have to script
around it — mirroring the remote's branch set, pruning without deleting someone's uncommitted work, fast-forwarding only
clean trees, doing it for twelve repositories from one file, on a schedule — is this tool.

It is also a clean answer to **dev-environment bootstrapping**: one config file describes every repo, branch and folder
layout your team works in. Commit it, and a fresh laptop lays down the whole workspace in one command — see
[Team workspace](#team-workspace).

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
(no `--reference`, no alternates). It exists so that no branch is a privileged "main" checkout: every branch, the default
included, is a peer directory.

**Clone mode** (`mode: "clone"`) is a first-class alternative per repository: a plain `git clone` of one branch into
`worktreeDir`, no bare repo, no per-branch subfolders. Reach for it when a repo must live at a fixed path — a dependency
sibling, a single-branch dev clone. See [Clone mode](./docs/clone-mode.md).

### What it will never do

- **Merge, rebase or reset a checkout you are working in.** An existing worktree is fast-forwarded only when it has no
  uncommitted or untracked changes and no unpushed commits; anything else is skipped and reported. Set
  `updateExistingWorktrees: false` to fetch only.
- **Remove a worktree that is not clean.** A worktree whose branch is gone upstream (or filtered out) is removed only
  when it has no uncommitted changes, unpushed commits, stashes, in-progress operations, modified submodules or detached
  HEAD — and by default "removed" means moved to `.trash/`, restorable for 30 days (`trash.enabled: false` deletes it
  instead). The one exception to "no unpushed commits": commits that were fully pushed before the remote branch was
  deleted (a squash merge) are trashed with their commits pinned.
- **Silently overwrite diverged commits.** A worktree whose branch has commits of its own *and* new upstream commits —
  after a force-push, or after someone else pushed the same branch — is moved to `.trash/` with its commits pinned (to
  `.diverged/` when trash is disabled) and a fresh checkout of upstream takes its place. If its content already matches
  upstream, or nothing was committed there since the last sync, it is reset in place instead; with a stash it is skipped.
- **Touch directories that are not its own.** Sync looks only at the worktrees git lists and at the exact path where a
  managed branch's worktree belongs. One consequence to know: a directory that already sits at that path but is not a
  registered worktree is treated as stale and moved to `.trash/` — and **deleted outright if you disable trash**.
- **Run your hooks unattended.** `hooks.onBranchCreated` and `filesToCopyOnBranchCreate` run only when you create a
  branch from the TUI's wizard, never on a tick or from an agent.

Every removal path, its gate, where it goes and how to undo it:
[Trash and recovery](./docs/trash-and-recovery.md#what-sync-can-remove).

### What it costs

- **Disk:** one bare repository per entry plus one full checkout per branch that passes the filters (LFS content
  included unless `skipLfs: true`). 200 live branches × a 300 MB checkout is 60 GB; bound it with `branchMaxAge`,
  `branchInclude`/`branchExclude` and `sparseCheckout`. A repository listed twice for different sparse layouts stores
  its history twice (a `.bare/` entry each). The TUI's status bar shows the total.
- **Network:** one `git fetch` per repository per tick (`--all --prune` in worktree mode), plus local status probes.
- **Processes:** git processes peak at `maxRepositories × the widest single limit`, 2 × 20 = 40 by default; the config
  loader refuses a peak above 100. See [Parallelism](./docs/configuration.md#parallelism).

## Install and quick start

```bash
npm install -g sync-worktrees
```

Requirements: **Node.js 24+**, **Git** (plus `git-lfs` on any machine syncing a repository that uses LFS, or set
`skipLfs: true`), **macOS or Linux** (`package.json` declares `os: ["darwin", "linux"]`; npm refuses the install on
Windows). `tmux` is needed only for the TUI's terminal-open wizard.

```bash
cd ~/projects/my-sync-dir
sync-worktrees init      # interactive wizard → writes sync-worktrees.config.js
sync-worktrees           # loads the config in the current directory and starts syncing
```

`sync-worktrees` with no arguments opens the [interactive TUI](#interactive-tui), syncs once straight away, then keeps
syncing on the schedule from your config — hourly by default (`defaults.cronSchedule`). Press `q` to quit.

For a one-shot run (CI, scripts, ad-hoc), add `--runOnce`: it syncs every repository once and exits 0 on success, 1 if
any repository failed (see [Exit codes](#exit-codes)). Nothing can answer a prompt in either mode, so credentials must
come from a credential helper or `ssh-agent` — see [Authentication](./docs/configuration.md#authentication).

`init` writes `sync-worktrees.config.js`; `.mjs`, `.cjs` and `.ts` are also accepted. If the config lives elsewhere,
pass it explicitly:

```bash
sync-worktrees --config /path/to/sync-worktrees.config.js
sync-worktrees --config /path/to/sync-worktrees.config.js --runOnce
sync-worktrees list --config ./config.js --filter "frontend-*"
```

### Running it unattended

- **Laptop.** Leave the TUI running in a `tmux` or `screen` window. A tick the machine slept through is not replayed;
  the next tick, or `s`, runs the cycle, and `syncOnStart` covers restarts.
- **Build box, no terminal.** There is no headless daemon: without `--runOnce` the TUI is what runs. Put
  `sync-worktrees --runOnce` on a cron line or a systemd/launchd timer instead. Two runs that overlap on one checkout do
  not collide — the second skips that repository and exits 0.
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

Repository settings override `defaults`; the default branch is always kept regardless of filters. Where each knob is
explained:

| Topic                                                               | Where                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Config formats, discovery, reload, `runOnce`, `syncOnStart`         | [Configuration reference](./docs/configuration.md)                        |
| Branch filtering (`branchInclude`, `branchExclude`, `branchMaxAge`) | [Branch filtering](./docs/configuration.md#branch-filtering)              |
| Credentials for HTTPS and SSH                                       | [Authentication](./docs/configuration.md#authentication)                  |
| Retry, LFS, `fetchTimeoutMs`, `cloneTimeoutMs`                      | [Retry, LFS and timeouts](./docs/configuration.md#retry-lfs-and-timeouts) |
| Parallelism, maintenance (`git gc`), locking                        | [Parallelism](./docs/configuration.md#parallelism) and the sections after |
| Clone mode and `depth`                                              | [Clone mode](./docs/clone-mode.md)                                        |
| Sparse checkout for monorepos                                       | [Sparse checkout](./docs/sparse-checkout.md)                              |
| Trash retention, restore, diverged branches                         | [Trash and recovery](./docs/trash-and-recovery.md)                        |
| `hooks.onBranchCreated`, `filesToCopyOnBranchCreate`                | [Hooks and file copying](./docs/hooks-and-file-copying.md)                |
| Every knob, annotated                                               | [`sync-worktrees.config.example.js`](./sync-worktrees.config.example.js)  |

### Team workspace

The onboarding pitch, concretely:

1. Keep `sync-worktrees.config.js` in a small workspace repository of its own. Use relative `worktreeDir`s (they resolve
   from the config file) or `path.join(os.homedir(), …)`, so the file is portable across home directories.
2. Keep credentials out of it: HTTPS through a credential helper, SSH through `ssh-agent`
   ([Authentication](./docs/configuration.md#authentication)); a private URL can come from `process.env`. URLs that do
   carry a token are redacted in logs and in `sync-worktrees list` output.
3. A new hire runs `git clone <workspace> && cd <workspace> && sync-worktrees --runOnce` (or `sync-worktrees` for the
   TUI), and `sync-worktrees list` to confirm what the config resolved to.
4. What stays manual: `hooks.onBranchCreated` and `filesToCopyOnBranchCreate` run only for branches created from the
   TUI wizard, so `.env` files and `npm install` for the worktrees the sync creates are still per-worktree steps.

## Interactive TUI

`sync-worktrees` with no arguments opens an Ink-based terminal UI: live logs, a manual sync trigger, wizards for the
common operations, and a status view across every repository.

| Key       | Action                                                 |
| --------- | ------------------------------------------------------ |
| `s`       | Sync all repositories now                              |
| `c`       | Create a branch (wizard: repo, base branch, name)      |
| `o`       | Open a worktree in a terminal (`tmux`) or a GUI editor |
| `w`       | Worktree status across repos, with flags per worktree  |
| `x`       | Force clean: purge trash and recovery refs, `git gc`   |
| `r`       | Reload the config and re-sync                          |
| `?` / `h` | Help                                                   |
| `q`       | Quit (`Esc` only backs out of what is open)            |

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

What an agent cannot do through it: delete, trash, restore or purge anything (the only removal path is `sync`'s own
safety-gated prune into `.trash/`, and `sync` is flagged destructive so clients can prompt); overwrite an existing
directory; force-push; create a branch your filters would prune again.

Setup for every client, what the server sees from where it is launched, the full tool table, safety in detail, and a
recipe for parallel agents on parallel branches: [MCP server](./docs/mcp.md).

## CLI reference

| Option      | Alias | Description                                                                        | Default |
| ----------- | ----- | ---------------------------------------------------------------------------------- | ------- |
| `--config`  | `-c`  | Path to JavaScript config file (auto-detected in CWD when omitted)                 | -       |
| `--runOnce` | -     | Run a sync once and exit, overriding config `runOnce` settings for this invocation | `false` |
| `--help`    | `-h`  | Show help                                                                          | -       |
| `--version` | -     | Print version                                                                      | -       |

Subcommands:

- `sync-worktrees init [--config <path>] [--force]` — interactive wizard that writes a minimal config file
  (`./sync-worktrees.config.js` by default). Refuses to overwrite an existing target unless `--force` is passed. The
  generated file is loaded back before the wizard reports success, so a config that would not load fails the command
  instead of surfacing on the next run.
- `sync-worktrees list [--config <path>] [--filter|-f <pattern>]` — print the resolved repositories and exit.
- `sync-worktrees trash [--config <path>] [--filter|-f <pattern>] [--json] [--restore <id> | --purge <id> | --dropKeepRef <name> | --dropAllKeepRefs] [--wait]`
  — inspect and recover reversible removals for exactly one worktree-mode repository. Flags, listing columns and the
  `--json` shape: [The `trash` subcommand](./docs/trash-and-recovery.md#the-trash-subcommand).

### Exit codes

- `sync-worktrees --runOnce` exits **0** when every repository synced, or was skipped because another process held its
  lock (whoever holds it is syncing it) or a clone-mode skip applied. It exits **1** when any repository failed to
  initialize, failed its sync after the retries, recorded a failed action (a rejected sparse pattern, for instance), or
  could not create its lock file at all. Ctrl-C exits **130** after cleanup.
- `sync-worktrees list` exits 1 when `--filter` matches nothing or the config does not load; `sync-worktrees trash`
  exits 1 on an expected failure (unknown id, occupied destination, a lock another process holds, a declined
  confirmation) with one `❌` line.

## Documentation

- [Configuration reference](./docs/configuration.md) — formats and discovery, whole-file settings, filtering,
  authentication, retry and timeouts, parallelism, maintenance, locking.
- [Clone mode](./docs/clone-mode.md) — one branch at a fixed path; `depth` and the ratcheted fetch cap.
- [Sparse checkout](./docs/sparse-checkout.md) — cone and no-cone patterns, one monorepo under several names.
- [Trash and recovery](./docs/trash-and-recovery.md) — every removal path, diverged branches, `.trash/` layout, keep
  refs, restoring.
- [Hooks and file copying](./docs/hooks-and-file-copying.md) — `hooks.onBranchCreated`, `filesToCopyOnBranchCreate`,
  pattern rules.
- [Interactive TUI](./docs/tui.md) — every key, the wizards, status flags, terminal and editor launch.
- [MCP server](./docs/mcp.md) — install in each client, auto-detect, every tool, safety, parallel agents.
- [`sync-worktrees.config.example.js`](./sync-worktrees.config.example.js) — every knob, annotated.
- [CHANGELOG.md](./CHANGELOG.md) — what changed in each release.

## Requirements

- Node.js >= 24.0.0
- Git; `git-lfs` where a repository uses LFS (otherwise `skipLfs: true`)
- macOS or Linux — Windows is not supported (`package.json` declares `os: ["darwin", "linux"]`)
- `tmux`, only for the TUI's terminal-open wizard
- An MCP-capable client, only for the optional `sync-worktrees-mcp` server

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT © [Yordan Kanchelov](https://github.com/yordan-kanchelov)
