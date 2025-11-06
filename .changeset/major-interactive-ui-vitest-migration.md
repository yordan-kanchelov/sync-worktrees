---
"sync-worktrees": major
---

# Interactive Terminal UI with ink + Vitest Migration

## Breaking Changes

### Test Framework: Jest → Vitest
- Migrated all 31 test files to Vitest for native ESM support
- Enables React component testing with ink-testing-library
- **Impact**: CI/CD pipelines must update test commands
- **Migration**: Replace `jest` with `vitest run`, `jest --watch` with `vitest`

### Build System: TypeScript Compiler → esbuild
- Switched to esbuild for ESM bundling with better performance
- Output is now single bundled file instead of transpiled modules

## New Features

### Interactive Terminal UI (ink-based)
- **Real-time sync status display** with live updates showing idle/syncing state
- **Keyboard controls**:
  - `?` or `h` - Toggle help modal
  - `s` - Trigger manual sync
  - `r` - Reload configuration
  - `q` or `Ctrl+C` - Graceful quit
