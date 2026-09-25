# MCP server

`sync-worktrees-mcp` speaks the [Model Context Protocol](https://modelcontextprotocol.io) over stdio; this page covers
installing it in each client, what the server sees from where it is launched, every tool it exposes, what it refuses to
do, and how to run several agents on parallel branches. The [README](../README.md#optional-mcp-server) has the
two-minute version. The folders on disk are ordinary directories either way — nothing here is required to use
sync-worktrees.

**Contents:** [Install in your client](#install-in-your-client) · [What the server sees](#what-the-server-sees) ·
[Available tools](#available-tools) · [Safety](#safety) · [Parallel agents on parallel
branches](#parallel-agents-on-parallel-branches)

In a single call, an AI assistant can discover every repo and worktree you have configured — so an agent working in
`frontend/` can grep across `backend/` and `shared/` without you reorienting it. That call is `detect_context` with
`includeAllWorktrees: true`; the response also includes a per-capability `{ available, reason }` block telling the agent
which operations are reachable from its current vantage point, so there's no guessing whether `sync` will work. See
[Available tools](#available-tools) for the full surface.

## Install in your client

Installing the package exposes a second binary, `sync-worktrees-mcp`. The **standard config** works in most clients:

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

If installed globally, replace `command` with `sync-worktrees-mcp` and drop `args`. The server needs Node 24+ on the
`PATH` the client spawns it with; if the client reports that it cannot start the server, check `which npx` from a plain
shell, and prefer the global install with `sync-worktrees-mcp` as `command` and no `args` when the client's `PATH` is
not your shell's.

**Upgrading from 6.x:** remove any `SYNC_WORKTREES_CONFIG` entry from the client's `env` (or the `-e` flag on
`claude mcp add`); 7.0.0 ignores it without a warning. A config outside the walk-up path is loaded with
`load_config {configPath}` instead.

<!-- Keep these blocks in step with site/src/content/data/clients.yaml, in the same order. -->

<details>
<summary>Claude Code</summary>

Use the Claude Code CLI:

```bash
claude mcp add --scope user sync-worktrees -- npx -y -p sync-worktrees sync-worktrees-mcp
```

`--scope user` makes the server available in every project on your machine. Claude Code's default scope is `local`,
which loads a server only in the project (directory) you added it from — and every worktree is a different directory, so
a locally scoped server added in `feature-a-0a5491ed/` is absent when you launch Claude Code in `feature-b-0a88c085/`.

</details>

<details>
<summary>Cursor</summary>

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project). Paste the **standard config** above. Use the
global file if you work across worktrees; a per-project `.cursor/mcp.json` lives in one checkout.

Or open `Cursor Settings` → `MCP` → `Add new MCP Server`, pick `command` type, and enter
`npx -y -p sync-worktrees sync-worktrees-mcp`.

</details>

<details>
<summary>Windsurf</summary>

Follow the Windsurf MCP [documentation](https://docs.windsurf.com/windsurf/cascade/mcp) and use the **standard config**
above.

</details>

<details>
<summary>Claude Desktop</summary>

Edit `claude_desktop_config.json` and paste the **standard config** above into the `mcpServers` block. Default location
on macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`. (Windows is not supported: the package
declares `os: ["darwin", "linux"]` and refuses to install there.)

Restart Claude Desktop after editing.

</details>

<details>
<summary>VS Code</summary>

Use the VS Code CLI:

```bash
code --add-mcp '{"name":"sync-worktrees","command":"npx","args":["-y","-p","sync-worktrees","sync-worktrees-mcp"]}'
```

Or put the same command and args as the **standard config** above under the `servers` key in `.vscode/mcp.json` (or
the user-level `mcp.json`, opened with **MCP: Open User Configuration**) — VS Code's `mcp.json` uses `servers`, not
`mcpServers`. See the VS Code MCP install
[guide](https://code.visualstudio.com/docs/copilot/chat/mcp-servers#_add-an-mcp-server).

</details>

<details>
<summary>Codex</summary>

Use the Codex CLI:

```bash
codex mcp add sync-worktrees -- npx -y -p sync-worktrees sync-worktrees-mcp
```

Or edit `~/.codex/config.toml`:

```toml
[mcp_servers.sync-worktrees]
command = "npx"
args = ["-y", "-p", "sync-worktrees", "sync-worktrees-mcp"]
```

</details>

<details>
<summary>Cline</summary>

Edit `cline_mcp_settings.json` (see [Configuring MCP Servers](https://docs.cline.bot/mcp/configuring-mcp-servers)) and
add:

```json
{
  "mcpServers": {
    "sync-worktrees": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "-p", "sync-worktrees", "sync-worktrees-mcp"],
      "disabled": false
    }
  }
}
```

</details>

<details>
<summary>opencode</summary>

Edit `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "sync-worktrees": {
      "type": "local",
      "command": ["npx", "-y", "-p", "sync-worktrees", "sync-worktrees-mcp"],
      "enabled": true
    }
  }
}
```

</details>

<details>
<summary>Warp</summary>

Open `Settings` → `AI` → `Manage MCP Servers` → `+ Add` (see [Warp MCP
docs](https://docs.warp.dev/knowledge-and-collaboration/mcp#adding-an-mcp-server)) and paste the **standard config**
above. Alternatively, run `/add-mcp` in the prompt.

</details>

<details>
<summary>Gemini CLI</summary>

Follow the Gemini CLI MCP install
[guide](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md#configure-the-mcp-server-in-settingsjson)
and use the **standard config** above.

</details>

## What the server sees

No config path is needed: the server runs in **auto-detect mode**.

- At startup it walks up from its own working directory (the client's CWD) for the first
  `sync-worktrees.config.{js,mjs,cjs,ts}` it finds, and when that directory sits inside a worktree managed by
  sync-worktrees it locates the bare repo, enumerates sibling worktrees and enables per-worktree operations.
- Without a config it still serves `detect_context`, `list_worktrees`, `get_worktree_status`, `create_worktree` and
  `update_worktree` for the repository it detected (the last two when the bare repository has an `origin` URL and the
  registered worktrees agree on a `worktreeDir`; otherwise `capabilities` names the reason).
- With a config that lists the repository it also serves `sync` and `initialize`. They stay unavailable for
  auto-detected repositories no matter which other tools have run.
- A config that is not in the CWD or one of its parents is loaded at runtime with `load_config {configPath}`, or —
  while no config is loaded yet — found with `detect_context {path}`, which walks up from the path it is given. Once a
  config is loaded, `detect_context {path}` never loads another one; `load_config {configPath}` switches, and replaces
  the loaded repositories.

| Launched from | The server finds | What the agent should do |
| --- | --- | --- |
| A worktree under the directory holding the config | The config and the repository; every tool is available (worktree mode — a clone-mode repository gets `sync` and `initialize` but not `create_worktree` / `update_worktree`) | Nothing |
| The directory holding the config, or any directory under it that is not a worktree (the workspace root, where `sync-worktrees` itself is run) | The config, auto-loaded, with every repository it lists; a single repository is selected. `detect_context` still answers `isWorktree: false` with every capability `available: false` — that block describes the probed path, not the server; read `configPath` and `configuredRepositories` instead, and every tool works | Nothing (`set_current_repository`, or pass `repoName`, when the config lists several repositories) |
| A worktree from which no config is reachable by walking up (an absolute `worktreeDir` outside the config's tree, for example) | The repository only: the worktree tools work, `sync` and `initialize` are refused with code `CAPABILITY_UNAVAILABLE` ("no config file loaded (running in auto-detect mode)") | `load_config {configPath}` |
| A directory with no config above it and no checkout above it (`~`, say) | Nothing: `detect_context` answers "No .git file found in path or any parent directory", every capability is `available: false`, and a bare `load_config` fails with "configPath required" | `detect_context {path: "<a worktree under the directory holding the config>"}` (walks up from that path, loads the config and selects the repository), or `load_config {configPath}` (required when the worktree lives outside the config's tree) |

## Available tools

| Tool                     | Purpose                                                                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detect_context`         | Inspect a path, resolve the bare repo, enumerate sibling worktrees, report config-driven sibling repositories and capabilities. With `includeStatus: true` each worktree carries `label`/`divergence`/`staleHint`, plus `statusError` when its status probe failed. Pass `includeAllWorktrees: true` to include every configured repo's worktrees keyed by repo name. |
| `list_worktrees`         | List worktrees with status label (`clean`/`dirty`/`stale`/`current`/`unknown` — the last when the status probe failed, with the reason in `safeToRemove.reason`), divergence, `safeToRemove`, last sync. Without `repoName` and with a loaded config, results are grouped across all configured repos.                        |
| `get_worktree_status`    | Detailed status for one worktree (dirty files, unpushed commits, stashes, operation in progress).                                                                                                                                 |
| `create_worktree`        | Worktree mode only (a clone-mode repository answers `CAPABILITY_UNAVAILABLE` — use `sync`). Create a worktree for a branch; optionally create the branch from `baseBranch`. Newly created branches are pushed to origin unless `push=false`. `worktreeExisted` is true when the worktree was already there (a no-op retry). |
| `update_worktree`        | Worktree mode only (a clone-mode repository answers `CAPABILITY_UNAVAILABLE` — use `sync`). Fast-forward one worktree to match upstream. `updated` is false when there was nothing to merge.                                     |
| `sync`                   | Full sync cycle (fetch, create, prune, update). Requires config. Streams progress notifications. `success` is false (with `failed`/`failures` listed) when any action failed, matching the CLI's exit code 1.                     |
| `initialize`             | Clone the bare repo and create the main worktree. Requires config. Streams progress.                                                                                                                                              |
| `load_config`            | Load or reload a config file at runtime.                                                                                                                                                                                          |
| `set_current_repository` | Select the active repo when multiple are configured.                                                                                                                                                                              |

All tools that target a single repo accept an optional `repoName`. When omitted, they use the current repository — set
by auto-detect, by a config listing exactly one repository, or by `set_current_repository`. With several repositories
configured and none of those in force, the call fails and names the repositories to choose from rather than picking one.

Arguments are validated strictly: a key no tool declares is rejected by name (`Unrecognized key: "repo_name"`) rather
than dropped, so a snake_case or misspelled `repoName` fails loudly instead of silently targeting the current repo.

The same context is also served as the `sync-worktrees://workspace` resource (JSON, re-probed on every read, never
cached) for clients that read resources instead of calling a tool.

### Error codes

Every failed call returns `{ error: true, code, message }` (with `isError`); branch on `code`:

| Code                     | Meaning                                                                                                              | What to do                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `CAPABILITY_UNAVAILABLE` | The tool is not available for this repository from here; the message carries the reason                              | Read `capabilities.<tool>.reason`: usually `load_config {configPath}`, or `sync` for a clone-mode repository |
| `SYNC_IN_PROGRESS`       | Another sync or operation holds the repository                                                                       | Retry                                                                      |
| `LOCK_UNAVAILABLE`       | The repository lock could not be created or taken (`ENOTDIR`, `EACCES`, `EROFS`, `ENOSPC`, …); nothing ran           | Fix the path the message names; retrying will not help                     |
| `TARGET_EXISTS`          | `create_worktree`'s target directory exists but is not a registered worktree                                         | Clean the path up, or let `sync` reconcile it                              |
| `BRANCH_FILTERED`        | `create_worktree` refused a branch `branchInclude`/`branchExclude`/`branchMaxAge` would prune                        | Adjust the config, or pass `force: true` (the response then warns)         |
| `DETACHED_HEAD`          | `update_worktree` on a worktree with no branch checked out                                                           | Check a branch out there and call again                                    |

Anything else carries the underlying error's own code — `CONFIG_FILE_NOT_FOUND` or `CONFIG_VALIDATION_FAILED` from
`load_config`, `GIT_*` from a git failure — with `INTERNAL_ERROR` for a plain thrown `Error` and `UNKNOWN_ERROR` for
anything that is not an `Error`; read `message`.

## Safety

- No tool deletes, trashes, restores or purges a worktree directly, and trash entries are not exposed at all — listing,
  restoring and purging are human operations. The only removal paths are `sync`'s own: it runs the same sync the CLI
  runs, so the same prune, stale-directory sweep and diverged replace apply, with the gates and destinations in
  [What sync can remove](./trash-and-recovery.md#what-sync-can-remove). With trash enabled (the default) nothing is
  deleted outright — everything lands in `.trash/` for 30 days, restorable with `sync-worktrees trash`; with
  `trash.enabled: false` the same prune is a permanent `git worktree remove`, and a stale non-git directory at a managed
  path is deleted outright. `sync` is registered with `destructiveHint: true`, so a client that confirms destructive
  tools prompts before running it.
- `create_worktree` refuses, before touching disk, when the target path is already registered to a different branch
  (`Sanitized worktree path … collides with existing branch …`), and errors with code `TARGET_EXISTS` when its target
  directory already exists but is not a registered worktree — it never moves an existing directory to trash or deletes
  it (clean the path up manually or let `sync` reconcile it).
- `sync` prunes every worktree outside the filtered branch set, so `create_worktree` refuses one it would take away
  again: `BRANCH_FILTERED` for a branch `branchInclude`/`branchExclude`/`branchMaxAge` exclude (`force: true`
  overrides), and a `warning` for a local-only branch until it is pushed.
- Push is create-only: branches created by sync-worktrees use `--no-track` first, then publish with
  `git push -u origin <branch> --force-with-lease=refs/heads/<branch>:`, so they do not inherit `origin/main` as their
  upstream and an existing remote ref is never advanced or force-updated — an empty lease is checked against "does not
  exist", so a name that turns out to be on origin already is rejected (`stale info`) rather than fast-forwarded.
- If that publish fails, `create_worktree` keeps the branch and the worktree: it answers `pushed: false` with the push
  error and the same local-only `warning`, so the branch is yours to push or delete (the next `sync` prunes it while it
  is local-only). The TUI's branch wizard, which owns the name it is creating, removes its local branch instead and
  offers the next free suffix.
- Path-targeted tools verify the supplied path is a registered worktree of the selected repository.
- `update_worktree` errors with code `DETACHED_HEAD` when the worktree has no branch checked out: there is nothing for a
  fast-forward to move, and the message names the path and the commit HEAD sits on. Check a branch out there and call it
  again.

## Parallel agents on parallel branches

The workflow the server is built for: one branch per agent, each in its own directory, several sessions at once.

1. **One branch per agent.** `create_worktree {branchName: "feat/a", baseBranch: "main"}` creates the branch, checks it
   out at `<worktreeDir>/feat-a-d54ad782/` (the branch name flattened plus eight hex characters of its SHA-256 — take
   `worktreePath` from the response rather than building it) and pushes it straight away (unless `push: false`), so the
   next sync keeps it rather than pruning a local-only branch.
2. **Start the agent there.** `cd` to the `worktreePath` in the response, or use the TUI's `o` → Terminal, which opens a
   `tmux` session in the worktree. Register the server at user scope (Claude Code: `--scope user`, see above) so it
   exists in every worktree, not only the one you added it from.
3. **Keep the branch current.** `update_worktree {path}` fetches and fast-forwards the worktree to
   `origin/<its own branch>` — it is "pull my branch", not "rebase me onto main"; rebasing is plain `git` in that
   directory.
4. **State is per session.** `load_config` and `set_current_repository` apply to the server process that received them,
   and each client launches a process of its own; a second session starts from auto-detect again.
5. **Two agents, one repository.** `create_worktree`, `update_worktree`, `sync` and `initialize` take the repository
   lock, so they are serialized across sessions and processes. The loser gets `SYNC_IN_PROGRESS`, which is retryable;
   `LOCK_UNAVAILABLE` means the lock could not be created at all and retrying will not help until the path it names is
   fixed. If you relocate the lock with `SYNC_WORKTREES_LOCK_DIR`, set it in the client's `env` for the server too —
   the server does not inherit your shell's export, and without it the agent's operations stop contending with your
   ticks.
6. **The schedule touches an agent's work in one case.** A scheduled sync fast-forwards an agent's worktree only when
   it is clean and fully pushed. Uncommitted edits are always skipped. Unpushed commits are skipped too — unless
   `origin/<branch>` has also moved (someone pushed to the agent's branch): then the worktree is diverged, and it is
   moved to `.trash/` with its commits pinned and a fresh checkout of upstream takes its place (reset in place instead
   when its content already matches upstream, or when nothing was committed there since the last sync — a bare
   force-push). One branch per agent, and push before anyone else touches it. See
   [Diverged branches](./trash-and-recovery.md#diverged-branches-force-pushes).
7. **Bootstrap is yours.** `hooks.onBranchCreated` and `filesToCopyOnBranchCreate` run only from the TUI's branch
   wizard, so a worktree an agent created has no `.env.local` and no `npm ci` yet: have the agent run those steps after
   `create_worktree`, or create the branch from the TUI (`c`) and hand the agent the path. See [Hooks and file
   copying](./hooks-and-file-copying.md).
