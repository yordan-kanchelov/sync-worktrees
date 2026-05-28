# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

sync-worktrees is a Git worktree synchronization tool that automatically manages Git worktrees to mirror remote repository branches. It can run as a scheduled cron job or as a one-time execution.

## Development Commands

### Build and Run
- `pnpm build` - Compile TypeScript to JavaScript (outputs to dist/)
- `pnpm dev` - Run in development mode with ts-node
- `pnpm start` - Run the compiled production build

### Code Quality
- `pnpm lint` - Check for linting errors
- `pnpm lint:fix` - Auto-fix linting errors
- `pnpm typecheck` - Run TypeScript type checking

### Testing
- `pnpm test` - Run all tests
- `pnpm test:watch` - Run tests in watch mode
- `pnpm test:coverage` - Run tests with coverage report

To run a single test file:
```bash
pnpm test path/to/test.test.ts
```

### Debugging
- `node --inspect-brk ./node_modules/.bin/jest` - Debug tests with Node.js inspector
- `pnpm dev -- [args]` - Debug the CLI with ts-node and pass arguments
- VS Code: Use the "Jest: Debug" configuration or set breakpoints in TypeScript files

### Release Management
- `pnpm changeset` - Create a changeset for version management
- `pnpm version` - Update versions based on changesets
- `pnpm release` - Build and publish to npm

## Architecture

### Core Services

#### High-Level Services
- **WorktreeSyncService** (`src/services/worktree-sync.service.ts`) - Main orchestrator that handles the sync lifecycle
  - Manages initialization, fetching, worktree creation/removal
  - Handles orphaned directory cleanup
  - Preserves worktrees with local changes
  - Orchestrates status checks and worktree operations

- **GitService** (`src/services/git.service.ts`) - Wrapper around simple-git for all Git operations
  - Manages bare repository and worktree operations
  - `getWorktrees()` - Parses Git worktree list with porcelain format
  - `addWorktree()` / `removeWorktree()` - Worktree lifecycle management
  - `fetchAll()` / `fetchBranch()` - Remote synchronization

- **ConfigLoaderService** (`src/services/config-loader.service.ts`) - Loads and validates JavaScript configuration files
  - Resolves relative paths from config file location
  - Supports repository filtering with wildcards
  - Applies global defaults to repositories

#### Utility Services (New Architecture)
- **WorktreeStatusService** (`src/services/worktree-status.service.ts`) - Extracted status checking logic
  - `checkWorktreeStatus()` - Checks if worktree has uncommitted changes
  - `hasUnpushedCommits()` - Checks if worktree has commits not in any remote (works even when upstream is deleted)
  - `hasUpstreamGone()` - Detects deleted remote branches
  - `hasStashedChanges()` - Checks for stashed work
  - `hasModifiedSubmodules()` - Checks submodule status
  - `hasOperationInProgress()` - Detects merge/rebase/cherry-pick/revert/bisect operations
  - `getFullWorktreeStatus()` - Comprehensive status with all safety checks
  - `validateWorktreeForRemoval()` - Safety validation before removal

- **PathResolutionService** (`src/services/path-resolution.service.ts`) - Centralized path operations
  - `toAbsolute()` / `toAbsoluteFrom()` - Convert relative to absolute paths
  - `sanitizeBranchName()` - Safe branch name handling (replaces slashes, special chars)
  - `normalizeWorktreePath()` - Validates paths within base directory
  - `isPathInsideBaseDir()` - Security check against path traversal
  - `extractBranchFromWorktreePath()` - Extract branch name from path

- **WorktreeMetadataService** (`src/services/worktree-metadata.service.ts`) - Metadata persistence
  - Tracks last sync commit for each worktree
  - Stores creation information and sync history
  - Helps detect unpushed commits when upstream is deleted

#### Supporting Modules
- **Constants** (`src/constants.ts`) - Centralized configuration and magic strings
  - Git constants (remote names, refs, operations)
  - Default configuration values
  - Error message patterns
  - Path constants

- **Errors** (`src/errors/index.ts`) - Typed error hierarchy
  - `SyncWorktreesError` - Base error with error codes and cause chains
  - `GitError` - Git operation errors (NotInitialized, OperationError, FastForwardError)
  - `WorktreeError` - Worktree-specific errors (AlreadyExists, NotClean)
  - `ConfigError` - Configuration validation errors
  - `PathResolutionError` - Path validation errors
  - `LfsError` - LFS-specific errors
  - Helper functions: `isLfsError()`, `isFastForwardError()`, `isNoUpstreamError()`

### Entry Points
- **CLI** (`src/index.ts`) - Main entry point with shebang for direct execution
  - Supports both single repository and multi-repository configurations
  - Interactive mode for missing required arguments
  - Manages cron scheduling and execution

### Key Flows
1. **Initialization**: Clone repository if needed, set up base worktree
2. **Synchronization**:
   - Fetch latest remote changes
   - Create worktrees for new remote branches
   - Remove worktrees for deleted remote branches (only if clean AND no unpushed commits)
   - Update existing worktrees that are behind upstream (if enabled and clean)
   - Clean up orphaned directories
   - Prune stale worktree metadata

### Bare Repository Storage
The tool uses a space-efficient bare repository pattern:
- Clones repositories as bare Git repositories in a `.bare` subdirectory
- Creates the main worktree in the parent directory
- All branch worktrees share the same Git object database
- This saves significant disk space compared to multiple full clones
- Example structure:
  ```
  my-repo/              # Main worktree
  my-repo/.bare/        # Bare repository (shared by all worktrees)
  worktrees/
    ├── main/          # Worktree for main branch
    ├── feature-1/     # Worktree for feature-1 branch
    └── feature-2/     # Worktree for feature-2 branch
  ```

### CLI Arguments

#### Single Repository Mode
- `--repoPath, -r` (required): Target repository directory
- `--repoUrl, -u`: Git repository URL for cloning
- `--worktreeDir, -w` (required): Directory for storing worktrees
- `--cronSchedule, -s`: Cron pattern (default: "0 * * * *")
- `--runOnce`: Execute once instead of scheduling
- `--branchInclude`: Only sync branches matching these patterns (comma-separated, supports wildcards)
- `--branchExclude`: Exclude branches matching these patterns (comma-separated, supports wildcards)
- `--no-update-existing`: Disable automatic updates of existing worktrees (default: updates enabled)

#### Config File Mode
- `--config, -c`: Path to JavaScript configuration file
- `--filter, -f`: Filter repositories by name (supports wildcards)
- `--list, -l`: List configured repositories and exit
- `--runOnce`: Override config to execute once

### Interactive Mode
When required arguments are missing in single repository mode, the CLI enters interactive mode:
- Prompts for missing `repoPath` and `worktreeDir` if not provided
- Validates paths and creates directories if they don't exist
- Automatically detects if a directory is already a Git repository
- If `repoUrl` is missing for a new repository, prompts for it interactively
- Uses the `@inquirer/prompts` library for user-friendly prompts
- Particularly useful for first-time setup or when running manually

## Configuration File Structure

Config files are JavaScript ES modules that export configuration for multiple repositories:

```javascript
export default {
  defaults: {
    cronSchedule: "0 * * * *",
    runOnce: false
  },
  repositories: [
    {
      name: "unique-identifier",
      repoUrl: "https://github.com/user/repo.git",
      repoPath: "/absolute/or/relative/path",
      worktreeDir: "/path/to/worktrees",
      cronSchedule: "*/30 * * * *",  // Optional override
      runOnce: false  // Optional override
    }
  ]
};
```

- Relative paths in config files are resolved from the config file location
- Supports environment variables and Node.js modules
- See `sync-worktrees.config.example.js` for advanced examples

### Environment Variables in Configuration
Configuration files can use environment variables and Node.js capabilities:
- Access environment variables via `process.env.VARIABLE_NAME`
- Use template literals for dynamic values: `${process.env.HOME}/repos`
- Conditionally include repositories based on environment
- Example:
  ```javascript
  export default {
    repositories: [
      {
        name: "my-project",
        repoUrl: process.env.REPO_URL || "https://github.com/user/repo.git",
        repoPath: `${process.env.HOME}/projects/my-project`,
        worktreeDir: process.env.WORKTREE_DIR || "./worktrees",
        cronSchedule: process.env.SYNC_SCHEDULE || "0 * * * *"
      }
    ]
  };
  ```

## Important Patterns

### Error Handling
- Typed error hierarchy with error codes and cause chains (see `src/errors/index.ts`)
- Specific error classes: `GitError`, `WorktreeError`, `ConfigError`, `PathResolutionError`, `LfsError`
- Helper functions for error detection: `isLfsError()`, `isFastForwardError()`, `isNoUpstreamError()`
- Worktree removal is skipped if there are local changes OR unpushed commits
- Process exits with code 1 on fatal errors
- Graceful degradation for non-critical operations
- Error messages include context (paths, branch names, reasons)

### Logging
- Timestamped logs for sync start/end
- Step-by-step progress indicators with emojis
- Clear warnings for skipped operations
- Detailed error context for debugging

### Testing
- **Test Suite**: 29 test suites, 403 tests (100% passing)
- **Coverage**: Good coverage with 80% thresholds enforced
- **Unit Tests**: Services tested in isolation with comprehensive mocks
- **Integration Tests**: Real workflows with temp directories
- **E2E Tests**: Real Git operations against public repos (octocat/Hello-World, github/gitignore)
- **Test Utilities**:
  - Fixtures in `src/__tests__/fixtures/`
  - Test helpers in `src/__tests__/test-utils.ts`
  - Mock factories for Git and Config
- **New Services**:
  - `PathResolutionService` - 22 tests covering all path operations
  - `WorktreeStatusService` - 26 tests covering all status checks
- Tests cover complete workflows, error scenarios, and edge cases
- E2E tests can be skipped with `SKIP_E2E_TESTS=true`

### Safety Features
- Two-phase validation before removing worktrees
- Preserves worktrees with uncommitted changes
- Preserves worktrees with unpushed commits (even if remote branch deleted)
- Only updates clean worktrees (no local changes)
- Updates use fast-forward merge only (no merge commits)
- Handles branch names with slashes correctly
- Cleans up orphaned directories not tracked by Git

## Code Style Guidelines

### Comments
- AVOID redundant comments that merely restate what the code does
- DO NOT add comments like:
  - `// Import modules` above imports
  - `// Define interfaces` above type definitions
  - `// Initialize` or `// Setup` before variable declarations
  - `// Export` before exports
  - Numbered step comments that duplicate console.log messages
  - Comments that just restate method names or obvious operations
- ONLY add comments when they provide valuable context that isn't clear from the code itself:
  - Complex business logic explanations
  - Non-obvious workarounds or edge cases
  - TODO items with specific context
  - Links to relevant documentation or issues
- Let the code be self-documenting through clear naming and structure
- If a comment just describes WHAT the code does (which is obvious from reading it), remove it
- If a comment explains WHY something is done a certain way (which isn't obvious), keep it

### Examples of unnecessary comments to avoid:
```typescript
// BAD - Redundant comments
// Initialize the service
const service = new Service();

// Loop through items
items.forEach(item => {
  // Process each item
  processItem(item);
});

// Convert relative path to absolute
if (!path.isAbsolute(inputPath)) {
  inputPath = path.resolve(inputPath);
}
```

### Examples of valuable comments:
```typescript
// GOOD - Provides context
// We need to check unpushed commits even when upstream is deleted
// to prevent data loss in orphaned branches
const hasUnpushed = await this.hasUnpushedCommits(worktreePath);

// Workaround for Node.js bug #12345 - remove when fixed
process.nextTick(() => callback());
```

## Creating Promotional GIFs

### Overview
The project includes scripts and instructions for creating promotional GIFs that demonstrate the sync-worktrees tool in action. The demo uses the popular github/gitignore repository as an example.

### Prerequisites
```bash
# Install required tools
brew install asciinema    # For recording terminal sessions
brew install agg           # For converting recordings to GIF
brew install gifsicle      # For optimizing GIFs
brew install tree          # For directory visualization
```

### Demo Scripts

#### Main Demo Script (`demo-recording/demo.sh`)
```bash
#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Clear terminal for clean recording
clear

# Show ASCII art logo (optional)
echo -e "${GREEN}"
echo "┌─────────────────────────────────────────┐"
echo "│     🌳 sync-worktrees                   │"
echo "│  Automatic Git Worktree Synchronization │"
echo "└─────────────────────────────────────────┘"
echo -e "${NC}"
sleep 2

# Show what we're about to do
echo -e "${BLUE}→ Demo: Syncing the popular github/gitignore repository${NC}"
echo -e "  This repository contains .gitignore templates for various languages"
echo ""
sleep 2

# Show the command we're running
echo -e "${YELLOW}$ npx sync-worktrees --repoUrl https://github.com/github/gitignore.git \\${NC}"
echo -e "${YELLOW}    --repoPath ./demo-recording/gitignore \\${NC}"
echo -e "${YELLOW}    --worktreeDir ./demo-recording/gitignore-worktrees \\${NC}"
echo -e "${YELLOW}    --runOnce${NC}"
echo ""
sleep 3

# Run sync-worktrees
node dist/index.js \
  --repoUrl https://github.com/github/gitignore.git \
  --repoPath ./demo-recording/gitignore \
  --worktreeDir ./demo-recording/gitignore-worktrees \
  --runOnce

# Add some spacing
echo ""

# Show the results with tree
echo -e "${GREEN}✨ Results - Each branch gets its own worktree:${NC}"
echo ""

# Show tree structure
tree -L 1 demo-recording/gitignore demo-recording/gitignore-worktrees

# Show space efficiency
echo ""
echo -e "${BLUE}💾 Space-efficient storage:${NC}"
echo -e "   • Bare repository: $(du -sh .bare/gitignore 2>/dev/null | cut -f1)"
echo -e "   • Shared Git objects across all worktrees"
echo ""

# Final pause to let viewers see the results
sleep 3
```

#### Recording Script (`demo-recording/record-demo.sh`)
```bash
#!/bin/bash

# Clean up any existing demo artifacts
rm -rf demo-recording/gitignore demo-recording/gitignore-worktrees .bare

# Start asciinema recording in the background
asciinema rec --quiet --overwrite demo-sync-worktrees.cast --command "./demo-recording/demo.sh"

echo "Recording completed!"
```

### Creating a New GIF

1. **Clean up any existing artifacts:**
   ```bash
   rm -rf demo-recording/gitignore demo-recording/gitignore-worktrees .bare *.gif *.cast
   ```

2. **Build the project:**
   ```bash
   pnpm build
   ```

3. **Run the recording script:**
   ```bash
   ./demo-recording/record-demo.sh
   ```

4. **Convert to GIF:**
   ```bash
   agg demo-sync-worktrees.cast sync-worktrees-demo.gif --theme monokai --font-size 14
   ```

5. **Optimize the GIF:**
   ```bash
   gifsicle -O3 --colors 256 --lossy=30 -o sync-worktrees-demo-optimized.gif sync-worktrees-demo.gif
   ```

### Customizing the Demo

To use a different repository or customize the demo:

1. **Change the repository:** Edit `demo.sh` and replace the github/gitignore URL with your desired repository
2. **Adjust timing:** Modify the `sleep` commands to control pacing
3. **Change theme:** Use different `--theme` options with agg (dracula, solarized-dark, etc.)
4. **Adjust size:** Use `--font-size` and terminal dimensions to control GIF size

### Tips for Best Results

- Keep the demo focused and under 30 seconds
- Use repositories with 3-8 branches for clarity
- Ensure terminal is clean before recording
- Test the demo script before recording
- The optimized GIF should be under 500KB for web use

## Architecture Improvements (January 2025)

### Overview
The codebase has been enhanced with new utility services and error handling to improve maintainability, testability, and code organization. All changes are **100% backward compatible**.

### New Modules

#### 1. Constants Module (`src/constants.ts`)
Centralized all magic strings and configuration defaults:
- `GIT_CONSTANTS` - Remote names, refs, operation markers
- `DEFAULT_CONFIG` - Default values for retry, cron, etc.
- `ERROR_MESSAGES` - Standardized error patterns
- `PATH_CONSTANTS` - File/directory names

#### 2. Error Hierarchy (`src/errors/index.ts`)
Type-safe error handling with error codes and cause chains:
- **Base**: `SyncWorktreesError` with error codes
- **Git**: `GitError`, `GitNotInitializedError`, `GitOperationError`, `FastForwardError`
- **Worktree**: `WorktreeError`, `WorktreeAlreadyExistsError`, `WorktreeNotCleanError`
- **Config**: `ConfigError`, `ConfigValidationError`
- **Other**: `PathResolutionError`, `LfsError`
- **Helpers**: `isLfsError()`, `isFastForwardError()`, `isNoUpstreamError()`

Benefits:
- Type-safe error handling with `instanceof` checks
- Error cause chains for debugging
- Consistent error messages
- Programmatic error detection

#### 3. PathResolutionService (`src/services/path-resolution.service.ts`)
Centralized path operations with security validation:
- `toAbsolute()` - Convert relative paths to absolute
- `toAbsoluteFrom()` - Resolve from base path
- `sanitizeBranchName()` - Safe branch name handling (replaces `/` with `-`, special chars with `_`)
- `normalizeWorktreePath()` - Validates paths within base directory
- `isPathInsideBaseDir()` - Prevents path traversal attacks
- `getBranchWorktreePath()` - Constructs branch worktree paths
- `extractBranchFromWorktreePath()` - Extracts branch name from path

Testing: 22 comprehensive tests covering all methods

#### 4. WorktreeStatusService (`src/services/worktree-status.service.ts`)
Extracted status checking logic from GitService:
- `checkWorktreeStatus()` - Basic clean status check
- `getFullWorktreeStatus()` - Comprehensive status with all checks and reasons
- `hasUnpushedCommits()` - Detects local commits (with optional lastSyncCommit)
- `hasUpstreamGone()` - Detects deleted remote branches
- `hasStashedChanges()` - Checks for stashed work
- `hasModifiedSubmodules()` - Submodule status check
- `hasOperationInProgress()` - Detects merge/rebase/cherry-pick/revert/bisect
- `validateWorktreeForRemoval()` - Safety validation throwing `WorktreeNotCleanError` if not safe

Testing: 26 comprehensive tests covering all scenarios

### Design Principles

1. **Single Responsibility**: Each service has one clear purpose
2. **Separation of Concerns**: Status checks, path operations, and error handling are isolated
3. **Testability**: Services can be tested in isolation without heavy mocking
4. **Security**: Path validation prevents traversal attacks
5. **Backward Compatibility**: No breaking changes to existing APIs

### Migration Guide

See `ARCHITECTURE_IMPROVEMENTS.md` for detailed migration examples and future refactoring plans.

### Benefits

- **Better Organization**: Logic grouped by responsibility
- **Easier Testing**: 48 new tests with minimal mocking
- **Type Safety**: Typed errors instead of generic Error instances
- **Security**: Centralized path validation
- **Maintainability**: Constants in one place, no magic strings
- **Debugging**: Error cause chains show full error context
