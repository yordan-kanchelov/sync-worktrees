# sync-worktrees

Automatically synchronize Git worktrees with remote branches. Keep your local worktrees in sync with remote repositories - perfect for multi-branch development workflows and automated testing setups.

## Features

- 🔄 Automatically creates worktrees for all remote branches
- 🗑️ Removes worktrees for deleted remote branches (preserves local changes)
- ⏰ Run as a scheduled cron job or one-time execution
- 🛡️ Safe operations - won't delete worktrees with uncommitted changes or unpushed commits
- 📝 Clear logging with timestamps and progress indicators
- 📋 Config file support for managing multiple repositories
- 💾 Space-efficient bare repository storage - no duplicate working trees

## Installation

```bash
npm install -g sync-worktrees
```

Or with pnpm:

```bash
pnpm add -g sync-worktrees
```

## Usage

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

## How it works

1. **Initialization**: 
   - Clones the repository as a bare repository (space-efficient, no working tree)
   - Creates a main worktree for immediate use
   - Stores bare repository in `.bare/<repo-name>` by default
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
# Setup
git clone https://github.com/yordan-kanchelov/sync-worktrees.git
cd sync-worktrees
pnpm install

# Build and test
pnpm build
pnpm test

# Run in development mode
pnpm dev -- --repoUrl https://github.com/user/repo.git --worktreeDir ./worktrees --runOnce
```

### Available Scripts

- `pnpm build` - Build the project
- `pnpm dev` - Run in development mode
- `pnpm test` - Run tests
- `pnpm test:watch` - Run tests in watch mode
- `pnpm test:coverage` - Run tests with coverage report
- `pnpm lint` - Check linting
- `pnpm lint:fix` - Auto-fix linting errors
- `pnpm typecheck` - Run type checking
- `pnpm changeset` - Create a changeset for your changes
- `pnpm version` - Update versions based on changesets
- `pnpm release` - Build and publish to npm

### Testing

The test suite uses Jest with comprehensive unit and integration tests. Common test utilities are available in `src/__tests__/test-utils.ts` including mock factories, test data constants, and helper functions. Use these utilities when writing tests to maintain consistency.

## Contributing

This project uses [changesets](https://github.com/changesets/changesets) to manage versions and releases.

### Making Changes

1. Make your changes and commit them
2. Write tests for your changes using the test utilities in `src/__tests__/test-utils.ts`
3. Run `pnpm changeset` to create a changeset describing your changes
4. Select the appropriate version bump type (patch/minor/major)
5. Write a summary of your changes for the changelog
6. Commit the generated changeset file

The CI will automatically create a PR to update versions when changesets are merged to main, and will publish to npm when that PR is merged.

## License

MIT © [Yordan Kanchelov](https://github.com/yordan-kanchelov)