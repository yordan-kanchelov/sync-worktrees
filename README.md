# sync-worktrees

Automatically synchronize Git worktrees with remote branches. Keep your local worktrees in sync with remote repositories - perfect for multi-branch development workflows and automated testing setups.

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

### One-time sync

```bash
sync-worktrees --repoPath /path/to/repo --worktreeDir /path/to/worktrees --runOnce
```

### Scheduled sync (default: hourly)

```bash
sync-worktrees --repoPath /path/to/repo --worktreeDir /path/to/worktrees
```

### Clone and sync a new repository

```bash
sync-worktrees \
  --repoPath /path/to/repo \
  --repoUrl git@github.com:user/repo.git \
  --worktreeDir /path/to/worktrees \
  --runOnce
```

### Using a config file

```bash
sync-worktrees --config ./sync-worktrees.config.js
```

## Options

| Option | Alias | Description | Required | Default |
|--------|-------|-------------|----------|---------|
| `--config` | `-c` | Path to JavaScript config file | No | - |
| `--filter` | `-f` | Filter repositories by name (wildcards supported) | No | - |
| `--list` | `-l` | List configured repositories and exit | No | `false` |
| `--repoPath` | `-r` | Absolute path to the target repository | Yes* | - |
| `--repoUrl` | `-u` | Git repository URL for cloning | No | - |
| `--worktreeDir` | `-w` | Directory for storing worktrees | Yes* | - |
| `--cronSchedule` | `-s` | Cron pattern for scheduling | No | `0 * * * *` (hourly) |
| `--runOnce` | - | Execute once and exit | No | `false` |
| `--help` | `-h` | Show help | No | - |

\* Required when not using a config file

## Examples

### Basic one-time sync
```bash
sync-worktrees -r /home/user/my-repo -w /home/user/my-repo-worktrees --runOnce
```

### Custom cron schedule (every 30 minutes)
```bash
sync-worktrees -r /home/user/my-repo -w /home/user/my-repo-worktrees -s "*/30 * * * *"
```

### Clone and sync a repository
```bash
sync-worktrees \
  -r /home/user/new-repo \
  -u https://github.com/example/project.git \
  -w /home/user/new-repo-worktrees \
  --runOnce
```

### Using a config file
```bash
# Sync all repositories in config
sync-worktrees --config ./sync-worktrees.config.js

# Sync specific repositories
sync-worktrees --config ./sync-worktrees.config.js --filter "frontend-*,backend-*"

# List configured repositories
sync-worktrees --config ./sync-worktrees.config.js --list

# Override config settings
sync-worktrees --config ./sync-worktrees.config.js --runOnce
```

## Configuration File

The config file is a JavaScript module that exports configuration for multiple repositories. This allows you to manage multiple repositories with different settings in a single command.

### Basic Config Structure

```javascript
module.exports = {
  // Optional global defaults
  defaults: {
    cronSchedule: "0 * * * *",
    runOnce: false
  },
  
  // Array of repository configurations
  repositories: [
    {
      name: "my-project",  // Unique identifier
      repoUrl: "https://github.com/user/repo.git",
      repoPath: "/path/to/repo",
      worktreeDir: "/path/to/worktrees",
      cronSchedule: "*/30 * * * *",  // Override default
      runOnce: false  // Override default
    }
  ]
};
```

### Config File Examples

#### Using Environment Variables
```javascript
module.exports = {
  repositories: [{
    name: "private-repo",
    repoUrl: process.env.PRIVATE_REPO_URL,
    repoPath: "/path/to/repo",
    worktreeDir: "/path/to/worktrees"
  }]
};
```

#### Using Relative Paths
```javascript
// Paths are resolved relative to the config file location
module.exports = {
  repositories: [{
    name: "local-project",
    repoPath: "./repos/my-project",
    worktreeDir: "./worktrees/my-project"
  }]
};
```

#### Multiple Repositories with Different Schedules
```javascript
module.exports = {
  defaults: {
    cronSchedule: "0 * * * *"  // Hourly by default
  },
  repositories: [
    {
      name: "frontend",
      repoUrl: "https://github.com/company/frontend.git",
      repoPath: "/projects/frontend",
      worktreeDir: "/projects/frontend-worktrees",
      cronSchedule: "*/30 * * * *"  // Every 30 minutes
    },
    {
      name: "backend",
      repoUrl: "https://github.com/company/backend.git", 
      repoPath: "/projects/backend",
      worktreeDir: "/projects/backend-worktrees"
      // Uses default hourly schedule
    }
  ]
};
```

## How it works

1. **Initialization**: Clones the repository if it doesn't exist (when `--repoUrl` is provided)
2. **Synchronization**:
   - Fetches latest changes from all remotes
   - Creates worktrees for new remote branches
   - Removes worktrees for deleted remote branches (only if they have no local changes and no unpushed commits)
   - Prunes stale worktree metadata

## Requirements

- Node.js >= 22.0.0
- Git

## Development

```bash
# Clone the repository
git clone https://github.com/yordan-kanchelov/sync-worktrees.git
cd sync-worktrees

# Install dependencies
pnpm install

# Build
pnpm build

# Run tests
pnpm test

# Development mode
pnpm dev -- --repoPath /path/to/repo --worktreeDir /path/to/worktrees --runOnce
```

### Available Scripts

- `pnpm build` - Build the project
- `pnpm dev` - Run in development mode
- `pnpm test` - Run tests
- `pnpm lint` - Check linting
- `pnpm typecheck` - Run type checking
- `pnpm changeset` - Create a changeset for your changes
- `pnpm version` - Update versions based on changesets
- `pnpm release` - Build and publish to npm

## Contributing

This project uses [changesets](https://github.com/changesets/changesets) to manage versions and releases.

### Making Changes

1. Make your changes and commit them
2. Run `pnpm changeset` to create a changeset describing your changes
3. Select the appropriate version bump type (patch/minor/major)
4. Write a summary of your changes for the changelog
5. Commit the generated changeset file

The CI will automatically create a PR to update versions when changesets are merged to main, and will publish to npm when that PR is merged.

## License

MIT © [Yordan Kanchelov](https://github.com/yordan-kanchelov)