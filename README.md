# sync-worktrees

Automatically synchronize Git worktrees with remote branches. Keep your local worktrees in sync with remote repositories - perfect for CI/CD environments, multi-branch development workflows, and automated testing setups.

## Features

- 🔄 Automatically creates worktrees for all remote branches
- 🗑️ Removes worktrees for deleted remote branches (preserves local changes)
- ⏰ Run as a scheduled cron job or one-time execution
- 🛡️ Safe operations - won't delete worktrees with uncommitted changes
- 📝 Clear logging with timestamps and progress indicators

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

## Options

| Option | Alias | Description | Required | Default |
|--------|-------|-------------|----------|---------|
| `--repoPath` | `-r` | Absolute path to the target repository | Yes | - |
| `--repoUrl` | `-u` | Git repository URL for cloning | No | - |
| `--worktreeDir` | `-w` | Directory for storing worktrees | Yes | - |
| `--cronSchedule` | `-s` | Cron pattern for scheduling | No | `0 * * * *` (hourly) |
| `--runOnce` | - | Execute once and exit | No | `false` |
| `--help` | `-h` | Show help | No | - |

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

## How it works

1. **Initialization**: Clones the repository if it doesn't exist (when `--repoUrl` is provided)
2. **Synchronization**:
   - Fetches latest changes from all remotes
   - Creates worktrees for new remote branches
   - Removes worktrees for deleted remote branches (only if they have no local changes)
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

## License

ISC