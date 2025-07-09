# sync-worktrees

Automatically synchronize Git worktrees with remote branches. Keep your local worktrees in sync with remote repositories - perfect for multi-branch development workflows and automated testing setups.

![sync-worktrees demo](./assets/sync-worktrees-demo-optimized.gif)

## How it works

sync-worktrees maintains a **separate working directory for each remote branch**, all sharing the same Git repository:

1. **First run**: Clones your repository as a bare repository (no working files, just Git data)
2. **Automatic sync**: 
   - Creates a dedicated worktree for **every remote branch** (`main`, `develop`, `feature/*`, etc.)
   - Each branch gets its own isolated directory with a full working copy
   - Fetches latest changes (doesn't merge - preserves your local work)
   - Removes worktrees when remote branches are deleted (preserves local changes)

**Why this matters**: Switch between branches instantly without stashing, run tests on multiple branches simultaneously, or keep your CI and production branches always ready.

## Features

- 🔄 Automatically creates worktrees for all remote branches
- 🗑️ Removes worktrees for deleted remote branches (preserves local changes)
- ⏰ Run as a scheduled cron job or one-time execution
- 🛡️ Safe operations - won't delete worktrees with uncommitted changes or unpushed commits
- 📝 Clear logging with timestamps and progress indicators
- 📋 Config file support for managing multiple repositories

## Installation

```bash
npm install -g sync-worktrees
```

Or with pnpm:

```bash
pnpm add -g sync-worktrees
```

## Usage

### Interactive Mode

When running without all required arguments, sync-worktrees will prompt you interactively:

```bash
# Interactive setup - prompts for missing values
sync-worktrees

# Or provide partial arguments and be prompted for the rest
sync-worktrees --repoUrl https://github.com/user/repo.git
```

### Command Line

```bash
# Single repository (one-time sync)
sync-worktrees --repoUrl https://github.com/user/repo.git --worktreeDir ./worktrees --runOnce

# Single repository (scheduled hourly)
sync-worktrees --repoUrl https://github.com/user/repo.git --worktreeDir ./worktrees

# Multiple repositories (using config file)
sync-worktrees --config ./sync-worktrees.config.js
```

## Options

| Option | Alias | Description | Required | Default |
|--------|-------|-------------|----------|---------|
| `--config` | `-c` | Path to JavaScript config file | No | - |
| `--filter` | `-f` | Filter repositories by name (wildcards supported) | No | - |
| `--list` | `-l` | List configured repositories and exit | No | `false` |
| `--repoUrl` | `-u` | Git repository URL (HTTPS or SSH) | Yes* | - |
| `--bareRepoDir` | `-b` | Directory for bare repository | No | `.bare/<repo-name>` |
| `--worktreeDir` | `-w` | Directory for storing worktrees | Yes* | - |
| `--cronSchedule` | `-s` | Cron pattern for scheduling | No | `0 * * * *` (hourly) |
| `--runOnce` | - | Execute once and exit | No | `false` |
| `--help` | `-h` | Show help | No | - |

\* Required when not using a config file

## Examples

### Single repository
```bash
# One-time sync
sync-worktrees -u https://github.com/user/repo.git -w ./worktrees --runOnce

# Scheduled sync (every 30 minutes)
sync-worktrees -u git@github.com:user/repo.git -w ./worktrees -s "*/30 * * * *"
```

### Using a config file
```bash
# Sync all repositories
sync-worktrees --config ./sync-worktrees.config.js

# Filter specific repositories
sync-worktrees --config ./sync-worktrees.config.js --filter "frontend-*"

# List configured repositories
sync-worktrees --config ./sync-worktrees.config.js --list
```

## Configuration File

For managing multiple repositories, create a JavaScript config file:

```javascript
module.exports = {
  // Optional defaults for all repositories
  defaults: {
    cronSchedule: "0 * * * *",  // Hourly
    runOnce: false
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
      worktreeDir: "/absolute/path/backend-worktrees"
      // Uses default schedule
    }
  ]
};
```

**Notes:**
- Relative paths are resolved from the config file location
- `bareRepoDir` defaults to `.bare/<repo-name>` if not specified
- Repository-specific settings override defaults

## Requirements

- Node.js >= 22.0.0
- Git

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT © [Yordan Kanchelov](https://github.com/yordan-kanchelov)
