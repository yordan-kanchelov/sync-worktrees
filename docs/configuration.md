# Configuration reference

Every setting sync-worktrees reads lives in `sync-worktrees.config.js`; this page explains the settings the annotated
[example config](../sync-worktrees.config.example.js) only names, grouped by what they control. The
[README](../README.md#configuration) has the short version and a realistic multi-repo example.

**Contents:** [File formats and discovery](#file-formats-and-discovery) · [Whole-file settings](#whole-file-settings) ·
[Repository entries](#repository-entries) · [Branch filtering](#branch-filtering) · [Authentication](#authentication) ·
[Retry, LFS and timeouts](#retry-lfs-and-timeouts) · [Parallelism](#parallelism) · [Maintenance](#maintenance) ·
[Locking](#locking)

Four topics have a page of their own: [Clone mode](./clone-mode.md), [Sparse checkout](./sparse-checkout.md), [Trash and
recovery](./trash-and-recovery.md) and [Hooks and file copying](./hooks-and-file-copying.md).

## File formats and discovery

Discovery tries `sync-worktrees.config.js`, `.mjs`, `.cjs` and `.ts`, in that order, in each directory from the
current one upwards; the first directory with a match wins. The CLI stops at your home directory when it starts inside
it (like a git ceiling directory: a config in `~` is found, one in `/home` or `/` is not); the MCP server walks to the
filesystem root. The CLI resolves its config in this order:

1. `--config <path>`.
2. The `SYNC_WORKTREES_CONFIG` environment variable, relative to the current directory. An empty value counts as unset;
   a path that does not exist is an error naming the variable, not a fall-through to discovery.
3. Discovery, as above.

`sync-worktrees` (unless `--quiet`) and `sync-worktrees list` print the file they used, and say when it came from a
parent directory or the variable. `trash` says so on stderr whenever the path did not come from `--config`. The MCP
server does not read `SYNC_WORKTREES_CONFIG` (see [MCP server](./mcp.md)).

A `.ts` config is run by Node directly, with no build step, so it must use erasable
syntax only (no `enum`, `namespace`, parameter properties or decorators). `init` writes `.js`, which is already
type-checked through its `@satisfies` JSDoc.

Config files are JavaScript modules — ES modules by default, CommonJS when the file is `.cjs` or the nearest
`package.json` declares `"type": "commonjs"` (`module.exports = config;` instead of `export default config;`).
`sync-worktrees init` picks the right one for you. Relative paths resolve from the config file's location, and you have
full access to `process.env` and Node module loading.

Splitting a config across several files is supported, including on reload: reloading (`r` in the interactive UI, the
`load_config` MCP tool) re-reads the config file **and** every module it pulls in, so editing `./repos.js` and pressing
`r` picks up the change without restarting. A reload re-evaluates the config on a worker thread to get that fresh read,
so the value a config file exports has to be plain data — strings, numbers, booleans, arrays, objects, and also `Date`,
`RegExp`, `Map`, `Set` and `BigInt`. A function cannot cross that boundary, and neither can a symbol, a `WeakMap` or a
`Proxy`; no setting takes any of them (`hooks.onBranchCreated` and the branch filters are arrays of strings), and a
reload that finds one fails with a message naming the value, leaving the previously loaded config running.

Every load validates the whole file and reports every problem it finds at once, one line each, naming the setting by its
path in the file and the repository it belongs to:

```text
Invalid configuration for 'repositories[1].cronSchedule' (repository 'api'): '0 * *' is not a valid cron expression
Invalid configuration for 'defaults.retry.maxAttempts': must be 'unlimited' or a positive safe integer, got 0
```

A key the loader does not know is not an error: it is ignored with a warning, and a near miss gets a suggestion
(`Unknown config key 'updateExistingWorktree' in repository 'web' is ignored (did you mean 'updateExistingWorktrees'?)`).

## Whole-file settings

Two settings describe the process rather than a repository. One process runs every repository in the file, so they live
under `defaults` only; setting either on a repository entry is a validation error.

- `defaults.runOnce` (default `false`) — sync every repository once and exit instead of opening the interactive UI and
  its schedule. `--run-once` on the command line turns it on for one invocation without editing the config.
- `defaults.syncOnStart` (default `true`) runs one sync as soon as the interactive UI starts, before the first cron tick
  — the same cycle a tick would run, so a restart after a config change takes effect immediately instead of a schedule
  period later. Set it to `false` to wait for the schedule. It has no effect under `runOnce`, which already syncs once
  and exits.

The schedule itself is a default with a per-repository override: `defaults.cronSchedule` is `"0 * * * *"` (hourly) when
unset, and a repository entry's own `cronSchedule` wins. Repositories that share a schedule are synced together on each
tick.

## Repository entries

- Relative `worktreeDir` and `bareRepoDir` paths resolve from the config file's location. `bareRepoDir` defaults to
  `.bare/<name>`, where `<name>` is the repository name taken from `repoUrl`. It is a worktree-mode setting: a
  clone-mode entry has no bare repository and rejects `bareRepoDir` outright, so the two rules below that name one do
  not apply to it (see [Clone mode](./clone-mode.md)).
- If the bare repository at `bareRepoDir` already exists, its `origin` must be `repoUrl` (compared ignoring `.git`, a
  trailing slash and scheme/host case); otherwise initialization fails naming both URLs. Run
  `git -C <bareRepoDir> remote set-url origin <repoUrl>` or point `bareRepoDir` at a fresh directory.
- Every entry needs its own directories: two entries that resolve to the same `worktreeDir` (in either mode) or the same
  `bareRepoDir`, or whose `worktreeDir` sits at or inside another entry's `bareRepoDir` (or vice versa), are rejected
  when the config loads, naming both entries and the path. A `worktreeDir` nested inside another entry's `worktreeDir`
  loads with a warning.
- Repository-specific settings override `defaults`.

### Worktree folder names

In worktree mode every branch gets a folder directly under `worktreeDir`. The default branch's folder is its name
(`main/`). Any other branch gets its **plain name**, the branch name with every `/` turned into `-`
(`feature/login` → `feature-login/`), unless that name would be ambiguous. In that case, and only then, it gets the
**hashed name**: the same flattening with any character outside letters, digits, `_` and `-` turned into `_`, capped
at 80 characters, then `-` and the first eight hex characters of the branch name's SHA-256
(`feature/login` → `feature-login-df7c7aeb/`).

A new worktree gets the hashed name when:

- the branch name holds anything other than ASCII letters, digits, `.`, `_`, `-` and `/`, flattens to more than 80
  characters, starts with `.` or `-`, ends with `.`, or is a Windows device name (`con`, `nul`, `com1`, ...);
- another branch on origin flattens to the same name, compared case-insensitively. Both get hashed names, so
  `feature/login` and `feature-login` never race for `feature-login/`, and neither do `Docs` and `docs`;
- the name is already used by a registered worktree of another branch (anywhere, since per-worktree metadata is keyed
  by folder name), by the default branch's folder (`main`, or `release` and `2024` for `release/2024`), by the tool's
  own folders (`.bare`, `.trash`, `.diverged`, `.removed`, ...), or by a metadata record another branch left behind;
- something that is not a checkout of this repository already sits at `<worktreeDir>/<plain name>`: a folder you
  made, a file, a symlink. It is left alone rather than moved aside.

The choice is made once, when the worktree is created. A worktree keeps the folder it was created with, so worktrees
created by earlier versions keep their hashed names and are never renamed; delete such a folder's worktree (or let sync
prune it) and the branch gets its plain name the next time it is created. A branch whose plain name becomes ambiguous
later (someone pushes `feature-login` next to `feature/login`) keeps its folder too; only the newcomer is hashed.

## Branch filtering

Two filters can be combined:

```javascript
defaults: {
  branchInclude: ["feature/*", "release-*", "main"],
  branchExclude: ["feature/wip-*"],
  branchMaxAge: "30d",
}
```

- **Name patterns** support `*` wildcards (including across `/`): `feature/*` matches `feature/login` and
  `feature/auth/oauth`.
- **`branchInclude`** keeps only matching branches; **`branchExclude`** removes matching branches. When both are set,
  include runs first, then exclude.
- **`branchMaxAge`** drops branches whose latest commit is older than the duration (`h`/`d`/`w`/`m`/`y` — e.g. `24h`,
  `30d`, `6m`, `1y`). Applied after name filtering.
- The default branch is always retained regardless of filters.
- Filters define the managed branch set. An existing managed worktree that no longer matches a filter is handled like a
  removed remote branch and is safety-checked, then moved to trash when removable.

## Authentication

sync-worktrees runs every git command non-interactively — on a scheduled tick in the interactive UI, in a `--run-once`
started by cron, or inside the MCP server, nobody can answer a prompt — so it sets `GIT_TERMINAL_PROMPT=0` — unless you
have exported that variable yourself, which is left alone so `--run-once` in a terminal can still prompt. Credentials
must come from a source that needs no prompt:

- **HTTPS** — a git credential helper (`git config --global credential.helper <helper>`, or your platform's keychain /
  credential manager) that already holds credentials for the remote. An askpass program (`GIT_ASKPASS`, `core.askPass`)
  keeps working. With `GIT_TERMINAL_PROMPT=0` in force, a remote that would prompt fails within a second with git's
  message plus a hint naming the fix, and that failure is not retried; if you exported the variable yourself, git
  prompts as it normally would and a run with no terminal waits instead.
- **SSH** — a key loaded into `ssh-agent` (or one without a passphrase) and the host already present in
  `~/.ssh/known_hosts`. A key the remote rejects or a host key that does not match fails at once with a hint and is not
  retried. Known limitation: `GIT_TERMINAL_PROMPT=0` covers git's own prompts only; ssh reads a key passphrase or an
  unknown-host confirmation from the terminal itself, so a passphrase-protected key without an agent or a host missing
  from `known_hosts` still blocks until the fetch inactivity timeout. sync-worktrees does not set `GIT_SSH_COMMAND`,
  because git gives it precedence over the `core.sshCommand` config key.

## Retry, LFS and timeouts

A failed sync attempt is retried automatically, but only for errors a retry can fix: DNS failures, refused connections,
timeouts, `EBUSY`, `Could not read from remote repository`, `fatal: unable to access`, and Git LFS failures. Everything
else fails on the first attempt — the credential, ssh key and host key failures git names in its message (see
[Authentication](#authentication) above), `EACCES`, `EPERM`, `EROFS`, `ENOSPC`, and any error not on that list.

Leave `retry` out and a sync runs with these defaults:

| Setting             | Default | Meaning                                                                                                |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `maxAttempts`       | `3`     | Attempts per sync, the first one included — so two retries. `"unlimited"` never stops retrying.        |
| `maxLfsRetries`     | `2`     | LFS failures tolerated before the sync ends with an LFS-specific error; also bounded by `maxAttempts`. |
| `initialDelayMs`    | `1000`  | Delay before the second attempt.                                                                       |
| `backoffMultiplier` | `2`     | Each delay multiplies the one before it: 1s, then 2s — 4s and 8s only once `maxAttempts` is raised.    |
| `maxDelayMs`        | `30000` | Ceiling on a single delay.                                                                             |
| `jitterMs`          | `0`     | Upper bound of a random extra delay — opt in when many repositories retry in lockstep.                 |

A `retry` block may sit at the top level, under `defaults` or on one repository, and the three merge field by field with
the repository winning: `retry: { maxAttempts: "unlimited" }` keeps trying instead of stopping at three,
`retry: { maxDelayMs: 60000 }` caps a single delay at a minute. When the attempts run out the sync fails — the
interactive UI logs it and waits for the next cron fire, while `--run-once` exits 1.

Two inactivity timeouts guard the git commands that talk to the remote: `fetchTimeoutMs` (default 5 minutes — `fetch`,
`push`, `ls-remote`, `remote set-head`) and `cloneTimeoutMs` (default 15 minutes — the initial clone, and the
`fetch --unshallow` that pulls a clone-mode repository's full history after `depth` is removed, which moves the same
bytes a clone would). Each kills its command when no output arrives inside the window, so a stalled connection ends the
attempt instead of hanging the sync forever; `0` disables one. Local commands never carry them: `git worktree add`
prints nothing while it checks out a large repository, and killing it there would fail a creation that only needed more
time. Set either on a repository entry or under `defaults` (the entry wins, as everywhere else); each must be `0` or a
whole number of milliseconds from `1000` to `2147483647` (Node's timer ceiling — a larger value would fire after 1 ms
and kill every command it guards, and anything under a second is almost always a value given in seconds). Anything else
is a config validation error. Both knobs are shown in
[`sync-worktrees.config.example.js`](../sync-worktrees.config.example.js).

For repositories with Git LFS issues or large files you don't need, set `skipLfs: true` in `defaults` or per repository.
The tool also falls back to LFS-free operation on LFS-specific failures: a worktree checkout that fails its smudge
filter (`git worktree add`) is retried once with LFS downloads disabled for the rest of that sync, and an LFS failure
that ends the whole sync attempt is retried the same way up to `retry.maxLfsRetries` times. Worktrees created after
the fallback hold LFS pointer files instead of content; the run still exits 0 (the fallback is recorded as
`lfs_skip_enabled` and logged, not failed) and a later sync does not fetch the content into files it does not touch —
run `git lfs pull` in those worktrees, or fix LFS access and recreate them.

## Parallelism

`parallelism` bounds concurrent **git processes**, not worktrees. It can sit at the top level (as below), under
`defaults`, or on a single repository — each layer overrides the one before it:

```javascript
parallelism: {
  maxRepositories: 2,      // repositories synced at once
  maxWorktreeCreation: 1,  // keep at 1 — git's worktree.lock makes parallel creation unsafe
  maxWorktreeUpdates: 3,
  maxWorktreeRemoval: 3,
  maxStatusChecks: 20,     // git processes spent on read-only status probes
  maxBranchFetches: 3,     // per-branch fetches, used only as a bulk-fetch fallback
}
```

A repository's phases run one after another — create, then prune, then update — so the whole run peaks at
`maxRepositories × the widest single limit`, never their sum. The config loader rejects a config whose peak exceeds 100
git processes and names the setting to lower. The defaults peak at 2 × 20 = 40.

### How the process budget is counted

One status check of a worktree runs up to nine git commands: `status`, `branch`, `branch -r`, `stash list` and
`submodule status` all at once, then up to four `rev-parse`/`rev-list` probes together. All of them share a single
`maxStatusChecks`-wide budget per repository, so a prune of 200 stale worktrees still peaks at `maxStatusChecks` git
processes.

Two things sit outside that count. Git spawns children of its own — `git submodule status` runs a helper script and a
child per submodule, measured on git 2.43 at roughly 1.5 git processes and 3 processes in total per call on an
eight-submodule superproject — so a budget spent entirely on superproject probes costs about three times its size. And
`maxWorktreeCreation`, `maxWorktreeRemoval` and `maxBranchFetches` each run their main git command through a single
shared client whose scheduler stops at 5, so setting them higher than 5 buys little: the per-branch fetch fallback stops
at 5 outright, while creation and removal grow a little past it for the few commands each unit runs on the worktree's
own client. That fetch fallback only runs when a bulk fetch fails on LFS errors, and is left out of the peak entirely,
so a config the loader reports as well inside the limit can still spawn about five fetches per repository if every
repository hits the fallback at once.

## Maintenance

Over time a repository accumulates unreachable Git objects — clone mode leaves them behind when single-branch fetches
narrow refs, and both modes churn objects as branches come and go. The optional `maintenance` block runs `git gc`
periodically to reclaim that storage and consolidate pack files. It applies to both modes and runs at the tail of a
successful sync, under the same repository operation lock as the sync itself (so it never races a fetch, merge, or
worktree operation).

```javascript
defaults: {
  maintenance: {
    enabled: true,      // default: true
    interval: "7d",     // default: "7d" — minimum time between runs
    aggressive: false,  // default: false
  },
}
```

- **`interval`** is a duration string (`h`/`d`/`w`/`m`/`y`). The last run is timestamped in the object store
  (`<bare-repo>/sync-worktrees-maintenance.json`, or `<worktreeDir>/.git/…` in clone mode), so throttling survives
  restarts and repeated `runOnce` invocations.
- **`aggressive: false`** (default) runs plain `git gc`, which honors Git's two-week grace period — recently-unreachable
  objects (and anything reachable from a branch, tag, stash, or reflog) are always preserved.
- **`aggressive: true`** runs `git gc --prune=now`, pruning recently-unreachable objects immediately. Use it only for
  explicit reclamation; the default is the safe choice. The repository operation lock only serializes sync-worktrees'
  own operations — `--prune=now` can still race manual `git` work happening in the checkout outside sync-worktrees, so
  avoid enabling it on repositories you also edit by hand concurrently. Every worktree shares the bare repository's
  object store, so this applies to work in any of them, not just the one you are looking at.
- A maintenance failure is logged as a warning and never fails the sync. The attempt is still timestamped, so a broken
  `gc` is throttled instead of retried every tick.

## Locking

Every sync runs under a cross-process repository lock, so the interactive UI's ticks, a `--run-once` from a shell or a
timer and the MCP server never operate on the same checkout at once. A run that finds the lock held is skipped with a
warning; a run that cannot create or take the lock fails and names the path and errno.

The lock file lives next to the checkout, in `<parent of worktreeDir>/.sync-worktrees-locks/<hash>.lock`, with
`worktreeDir` resolved through symlinks first. Nothing in the environment feeds into that path: a `--run-once` started
by cron, launchd or a systemd timer with a minimal environment, a shell whose dotfiles export `XDG_STATE_HOME`, and
`sudo` with or without `-E` all contend for the same file as long as they point at the same `worktreeDir`. Worktree-mode
repositories additionally lock the bare repository directory. Locks are never placed under `~/.cache` or inside
`worktreeDir` itself.

`SYNC_WORKTREES_LOCK_DIR` moves the lock files to another directory — for a checkout whose parent directory is
read-only, for instance. It is an escape hatch, not a preference: give it the same absolute path in every process that
syncs the same `worktreeDir`, otherwise those processes stop contending for one lock.
