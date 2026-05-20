# sync-worktrees

Automatically synchronize Git worktrees with remote branches. Keep your local worktrees in sync with remote repositories - perfect for multi-branch development workflows and automated testing setups.

![sync-worktrees demo](./assets/sync-worktrees-demo-optimized.gif)

## How it works

sync-worktrees supports two repository strategies. The default — **worktree mode** — maintains a separate working directory for each remote branch, all sharing the same Git repository:

1. **First run**: Clones your repository as a bare repository (no working files, just Git data)
2. **Automatic sync**: 
   - Creates a dedicated worktree for **every remote branch** (`main`, `develop`, `feature/*`, etc.)
   - Each branch gets its own isolated directory with a full working copy
   - Fetches latest changes (doesn't merge - preserves your local work)
   - Removes worktrees when remote branches are deleted (preserves local changes)

**Clone mode** is an alternative first-class strategy (`mode: "clone"`) that performs a single-branch `git clone` directly into `worktreeDir` — no bare repo, no per-branch subfolders, just one checked-out branch. Designed for monorepo sibling dependencies that need fixed relative paths. See [Clone Mode And Depth](#clone-mode-and-depth).

**Why this matters**: Switch between branches instantly without stashing, run tests on multiple branches simultaneously, or keep your CI and production branches always ready.

## Features

- 🔄 Automatically creates worktrees for all remote branches
- 🗑️ Removes worktrees for deleted remote branches (preserves local changes)
- ⏰ Run as a scheduled cron job or one-time execution
- 🛡️ Safe operations - won't delete worktrees with uncommitted changes or unpushed commits
- 📝 Clear logging with timestamps and progress indicators
- 📋 Config file support for managing multiple repositories
- 🔁 Automatic retry with exponential backoff for network and filesystem errors
- 🕐 Branch age filtering - only sync branches active within a specified time period
- 🔀 Smart handling of rebased/force-pushed branches with automatic divergence detection
- 🤖 MCP server for AI assistants - inspect and manage worktrees from Claude Desktop, Claude Code, Cursor, etc.

## Installation

```bash
npm install -g sync-worktrees
```

Or with pnpm:

```bash
pnpm add -g sync-worktrees
```

## Usage

`sync-worktrees` always runs against a config file. Create one once, then run the tool.

```bash
cd ~/projects/my-sync-dir
sync-worktrees init      # interactive wizard → writes sync-worktrees.config.js
sync-worktrees           # auto-loads the config in the current directory and starts syncing
```

To manage multiple repositories, edit the generated config file and add entries under `repositories`. See [Configuration File](#configuration-file).

### Explicit config path

Useful when the config lives outside the current directory:

```bash
sync-worktrees --config /path/to/sync-worktrees.config.js
sync-worktrees list --config ./config.js
sync-worktrees list --config ./config.js --filter "frontend-*"
```

### Subcommands

- `sync-worktrees init [--config <path>] [--force]` — interactive wizard that writes a minimal config file (`./sync-worktrees.config.js` by default) and exits. Refuses to overwrite an existing target unless `--force` is passed.
- `sync-worktrees list [--config <path>] [--filter <pattern>]` — print the resolved repositories and exit.

### Opening a worktree from the TUI

Press `o` in the interactive TUI to open the selected worktree. The wizard supports two modes, toggled with `Tab`:

- **Terminal** (default) — launches a new terminal window with a `tmux` session attached to the worktree directory. Session name is `<repo>-<sanitized-branch>`; re-opening the same worktree attaches to the existing session instead of creating a duplicate.
- **Editor** — launches `$EDITOR` / `$VISUAL` (falls back to `code`) in the worktree.

Terminal mode requires [`tmux`](https://github.com/tmux/tmux) to be installed.

#### Environment variables

| Variable | Purpose | Default behavior |
|----------|---------|------------------|
| `SYNC_WORKTREES_TERMINAL` | Override the terminal launcher on any platform. Value is a command string; the tmux invocation is appended via `sh -c`. Example: `SYNC_WORKTREES_TERMINAL="alacritty -e"`. | See per-platform defaults below. |
| `TERMINAL` | Linux-only fallback when `SYNC_WORKTREES_TERMINAL` is unset. Same format. | Probes `gnome-terminal`, `konsole`, `alacritty`, `kitty`, `xterm` in order. |
| `EDITOR` / `VISUAL` | Editor mode launcher. | Falls back to `code`. |

Per-platform terminal defaults (when no env override is set):

- **macOS** — Ghostty if `Ghostty.app` is installed, otherwise Terminal.app via AppleScript.
- **Linux** — `$TERMINAL` if set; otherwise the first found among the candidates above.

## MCP Server

sync-worktrees ships a [Model Context Protocol](https://modelcontextprotocol.io) server so AI assistants (Claude Desktop, Claude Code, Cursor, Windsurf, etc.) can inspect and manage your worktrees directly. Installing the package exposes a second binary, `sync-worktrees-mcp`, that speaks MCP over stdio.

### Setup

Add the server to your MCP client config. Use `npx` if the package is not installed globally:

```json
{
  "mcpServers": {
    "sync-worktrees": {
      "command": "npx",
      "args": ["-y", "-p", "sync-worktrees", "sync-worktrees-mcp"],
      "env": {
        "SYNC_WORKTREES_CONFIG": "/absolute/path/to/sync-worktrees.config.js"
      }
    }
  }
}
```

If installed globally, replace `command` with `sync-worktrees-mcp` and drop `args`. `SYNC_WORKTREES_CONFIG` is optional — without it the server runs in **auto-detect mode**: when the client's CWD sits inside a worktree managed by sync-worktrees, the server locates the bare repo, enumerates sibling worktrees, and enables per-worktree operations. Sync and initialize require a loaded config (or call `load_config` at runtime).

At session start, agents should call `detect_context` with `includeAllWorktrees: true`. With a loaded config, that returns config-driven `siblingRepositories` for every other configured repo, including nested `worktreeDir` paths, plus `allWorktreesByRepo` keyed by repository name. If a configured repo cannot be enumerated, `allWorktreeErrorsByRepo` carries the per-repo error.

Client-specific locations:

| Client | Config file |
|--------|-------------|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| Claude Code | `claude mcp add sync-worktrees -- npx -y -p sync-worktrees sync-worktrees-mcp` |
| Cursor | `~/.cursor/mcp.json` (or project-level `.cursor/mcp.json`) |

### Available tools

| Tool | Purpose |
|------|---------|
| `detect_context` | Inspect a path, resolve the bare repo, enumerate sibling worktrees, report config-driven sibling repositories and capabilities. Pass `includeAllWorktrees: true` to include every configured repo's worktrees keyed by repo name. |
| `list_worktrees` | List worktrees with status label (`clean`/`dirty`/`stale`/`current`), divergence, `safeToRemove`, last sync. Without `repoName` and with a loaded config, results are grouped across all configured repos. |
| `get_worktree_status` | Detailed status for one worktree (dirty files, unpushed commits, stashes, operation in progress). |
| `create_worktree` | Create a worktree for a branch; optionally create the branch from `baseBranch`. Newly created branches are pushed to origin unless `push=false`. |
| `remove_worktree` | Remove a worktree after safety checks; `force=true` skips validation. |
| `update_worktree` | Fast-forward one worktree to match upstream. |
| `sync` | Full sync cycle (fetch, create, prune, update). Requires config. Streams progress notifications. |
| `initialize` | Clone the bare repo and create the main worktree. Requires config. Streams progress. |
| `load_config` | Load or reload a config file at runtime. |
| `set_current_repository` | Select the active repo when multiple are configured. |

All tools that target a single repo accept an optional `repoName`. When omitted, they use the current repository — set by auto-detect, the first entry in the config, or `set_current_repository`.

### Safety

- `remove_worktree` refuses to delete worktrees with uncommitted changes, unpushed commits, stashes, or operations in progress (merge/rebase/cherry-pick/revert/bisect). Pass `force=true` to override.
- `create_worktree` rejects sanitized-path collisions (e.g. `feature/foo` vs `feature-foo` both resolving to `feature-foo/`) before touching disk.
- Branches created by sync-worktrees use `--no-track` first, then publish with `git push -u origin <branch>`, so they do not inherit `origin/main` as their upstream.
- Path-targeted tools verify the supplied path is a registered worktree of the selected repository.

## Options

The CLI loads a config file and runs it. All run-mode settings (`runOnce`, debug, branch filters, retry, parallelism, LFS, clone mode, depth, etc.) live in the config file — see [Configuration File](#configuration-file).

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--config` | `-c` | Path to JavaScript config file (auto-detected in CWD when omitted) | - |
| `--help` | `-h` | Show help | - |
| `--version` | - | Print version | - |

Subcommands:

- `sync-worktrees init [--config <path>] [--force]` — create a new config file interactively.
- `sync-worktrees list [--config <path>] [--filter <pattern>]` — list configured repositories and exit.

## Configuration File

For managing multiple repositories, create a JavaScript ES module config file:

```javascript
export default {
  // Optional defaults for all repositories
  defaults: {
    cronSchedule: "0 * * * *",  // Hourly
    runOnce: false,
    branchMaxAge: "30d",  // Only sync branches active in last 30 days
    branchExclude: ["wip-*", "tmp-*"],  // Exclude WIP and temporary branches
    updateExistingWorktrees: true  // Auto-update worktrees that are behind (default: true)
  },

  // Retry configuration (optional - these are the defaults)
  retry: {
    maxAttempts: 'unlimited',  // or a number like 5
    initialDelayMs: 1000,      // Start with 1 second
    maxDelayMs: 600000,        // Max 10 minutes between retries
    backoffMultiplier: 2       // Double the delay each time
  },

  repositories: [
    {
      name: "frontend",  // Unique identifier
      repoUrl: "https://github.com/company/frontend.git",
      worktreeDir: "./worktrees/frontend",  // Relative paths supported
      cronSchedule: "*/30 * * * *"  // Override default
    },
    {
      name: "backend",
      repoUrl: process.env.BACKEND_REPO_URL,  // Environment variables supported
      worktreeDir: "/absolute/path/backend-worktrees",
      branchMaxAge: "6m",  // Override: only sync branches active in last 6 months
      branchInclude: ["feature/*", "release-*", "main"],  // Only sync specific branches
      // Uses default schedule
      retry: { maxAttempts: 10 }  // Override retry for this repo
    }
  ]
};
```

**Notes:**
- Relative paths are resolved from the config file location
- `bareRepoDir` defaults to `.bare/<repo-name>` if not specified
- Repository-specific settings override defaults

### Clone Mode And Depth

Config-file repositories can set `mode: "clone"` to clone one branch directly into `worktreeDir` instead of maintaining one worktree per remote branch:

```javascript
{
  name: "game-platform",
  repoUrl: "ssh://git@example.com/game-platform.git",
  worktreeDir: "./slots/game-platform",
  mode: "clone",
  branch: "main",
  depth: 1  // Optional: initial `git clone --depth 1`
}
```

`depth` is valid only for clone-mode repositories and must be a positive safe integer. It applies to the initial clone only. If an existing clone is shallow and the resolved config no longer includes `depth`, the next sync fetches full history with `git fetch --unshallow` before the normal fetch and fast-forward check. Changing or shrinking an existing shallow depth requires a manual reclone.

### Retry Configuration

The tool automatically retries on network errors and filesystem race conditions:

- **Default behavior**: Unlimited retries with exponential backoff (1s, 2s, 4s... up to 10 minutes)
- **Network errors**: Connection timeouts, DNS failures, repository access issues
- **Filesystem errors**: Busy files, permission issues, race conditions

Simple retry examples:
```javascript
// Global retry configuration
retry: { maxAttempts: 5 }                    // Try 5 times then stop
retry: { maxAttempts: 'unlimited' }          // Keep trying forever (default)
retry: { maxDelayMs: 60000 }                 // Cap retry delay at 1 minute
retry: { initialDelayMs: 5000 }              // Start with 5 second delay

// Per-repository override
repositories: [{
  name: "critical-repo",
  // ... other config ...
  retry: { maxAttempts: 'unlimited', initialDelayMs: 10000 }
}]
```

### Git LFS Support

For repositories with Git LFS issues or when large files aren't needed, set `skipLfs` in the config file:

```javascript
defaults: {
  skipLfs: true
}

// or per repository
repositories: [{ name: "big-binary-repo", skipLfs: true }]
```

The tool automatically handles LFS errors by retrying with LFS disabled (max 2 retries by default, configurable via `retry.maxLfsRetries`).

### Branch Name Filtering

You can control which branches get synced using include and exclude patterns. This is useful for repositories where you only care about specific branch types (e.g., feature branches) or want to skip certain patterns (e.g., WIP branches).

**Pattern syntax**: Patterns support `*` wildcards that match any characters (including `/` in branch names).
- `feature/*` - matches `feature/login`, `feature/auth/oauth`, etc.
- `release-*` - matches `release-1.0`, `release-2.0-beta`, etc.
- `*-hotfix` - matches `urgent-hotfix`, `prod-hotfix`, etc.

**Filtering semantics**:
- `branchInclude` - only branches matching at least one pattern are synced
- `branchExclude` - branches matching any pattern are skipped
- When both are set, include runs first, then exclude removes from the result
- The default branch (e.g., `main`) is always retained regardless of filters

**Examples** — set in the config file:

```javascript
// Global default
defaults: {
  branchExclude: ["wip-*", "tmp-*"]
}

// Per repository
repositories: [{
  name: "frontend",
  branchInclude: ["feature/*", "release-*"],
  branchExclude: ["feature/wip-*"],
}]
```

**Combining with age filtering**: Branch name filtering runs first, then age filtering (`branchMaxAge`) is applied to the remaining branches.

```javascript
// Only feature branches active in the last 30 days
repositories: [{
  name: "frontend",
  branchInclude: ["feature/*"],
  branchMaxAge: "30d",
}]
```

### Branch Age Filtering

To reduce clutter and save disk space, you can configure sync-worktrees to only sync branches that have been active within a specified time period. This is particularly useful for repositories with many stale or abandoned branches.

**Duration format**: `<number><unit>`
- `h` - hours (e.g., `24h`)
- `d` - days (e.g., `30d`)
- `w` - weeks (e.g., `4w`)
- `m` - months (e.g., `6m`)
- `y` - years (e.g., `1y`)

**Examples** — set in the config file:

```javascript
// Global default
defaults: {
  branchMaxAge: "90d"  // Only sync branches active in last 90 days
}

// Per repository
repositories: [{
  name: "active-project",
  branchMaxAge: "14d",  // Very active project - only last 2 weeks
}, {
  name: "legacy-project",
  branchMaxAge: "1y",   // Legacy project - keep branches from last year
}]
```

When branch filtering is active, the tool will:
- Fetch commit timestamps for all remote branches
- Filter out branches older than the specified age
- Log how many branches were excluded
- Only create/maintain worktrees for active branches

### Handling Rebased and Force-Pushed Branches

sync-worktrees intelligently handles branches that have been rebased or force-pushed to prevent data loss:

**Automatic behavior (no configuration needed):**

1. **Clean rebases** - When a branch is rebased but the file content remains identical:
   - Automatically resets the worktree to match the upstream
   - No data loss since the content is the same

2. **Diverged branches with NO local changes** - When someone force-pushes but you haven't made local commits:
   - Automatically resets to the new upstream state
   - No move to `.diverged` since you have no work to preserve
   - Keeps `.diverged` clean by only preserving actual user work

3. **Diverged branches WITH local changes** - When a branch has different content AND you've made local commits:
   - Moves the worktree to `.diverged` directory within your worktrees folder
   - Preserves all your local changes and commits
   - Creates a fresh worktree from the upstream branch
   - Logs clear instructions for reviewing diverged changes

**Example diverged structure:**
```
my-repo-worktrees/
├── main/
├── feature-a/
├── feature-b/
└── .diverged/                      # Hidden diverged directory
    ├── 2024-01-15-feature-x/      # Timestamp + branch name
    │   ├── .diverged-info.json    # Metadata about the divergence
    │   └── [all your local files]
    └── 2024-01-16-feature-y/
        ├── .diverged-info.json
        └── [all your local files]
```

**Reviewing diverged worktrees:**
```bash
# See what's different
cd my-repo-worktrees/.diverged/2024-01-15-feature-x
git diff origin/feature-x

# If you want to keep your changes
git push --force-with-lease

# If you want to discard and use upstream
cd ../..
rm -rf .diverged/2024-01-15-feature-x
```

This ensures you never lose work due to force pushes while keeping your worktrees in sync with upstream.

### Sparse Checkout

For monorepos where you only need a subset of folders, set `sparseCheckout` per repository entry. The tool runs `git worktree add --no-checkout`, configures sparse-checkout, then materializes only the included paths. The same repository can be listed multiple times under different `name`s with different sparse patterns to build domain-grouped layouts.

```js
export default {
  repositories: [
    {
      name: "roulette-game-client",
      repoUrl: "https://github.com/acme/casino-monorepo.git",
      worktreeDir: "/Users/me/game-clients/roulette",
      sparseCheckout: { include: ["game-client"] },
    },
    {
      name: "roulette-autocue",
      repoUrl: "https://github.com/acme/casino-monorepo.git",
      worktreeDir: "/Users/me/autocues/roulette",
      sparseCheckout: { include: ["autocue"] },
      // bareRepoDir: ".bare/roulette-autocue", // pin to make config reorder-proof
    },
  ],
};
```

**Modes:**

- `cone` (default): pass folder names in `include`. Fast and recommended.
- `no-cone`: pass gitignore-style patterns including `!negation`. Required for `exclude` and any `!`-prefixed include.

If you set `exclude` or use `!`-prefixed patterns while `mode: "cone"` is explicit, the tool auto-promotes to `no-cone` and logs a warning.

**Duplicate `repoUrl` handling:**

The first entry per `repoUrl` keeps the URL-derived bare path (`.bare/<repo-slug>`). Subsequent duplicate entries auto-derive `bareRepoDir` from `name` (`.bare/<name>`) so they do not collide. Pin `bareRepoDir` explicitly on duplicate entries if you want config order to be irrelevant.

**Narrowing safety:**

When a sync would narrow an existing worktree's sparse patterns (remove a previously included path), it first checks the worktree is clean. If there are uncommitted changes, unpushed commits, or in-progress operations, the sparse update is skipped with a warning. Clean or stash local changes to apply the narrower patterns.

## Requirements

- Node.js >= 22.0.0
- Git
- [`tmux`](https://github.com/tmux/tmux) (optional, required only for Terminal mode in the TUI)
- An MCP-capable client (optional, only for the `sync-worktrees-mcp` server)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT © [Yordan Kanchelov](https://github.com/yordan-kanchelov)
