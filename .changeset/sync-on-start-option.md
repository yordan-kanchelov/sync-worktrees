---
"sync-worktrees": minor
---

Add interactive UI commands and improvements

### New UI Commands
- Press `c` to open the **Branch Creation Wizard** - create and push new branches with validation
- Press `o` to open the **Editor Wizard** - quickly open your editor in any worktree
- Arrow keys to scroll through logs in the new **Log Panel**

### New Configuration Option
- `filesToCopyOnBranchCreate` - specify files to automatically copy from the base branch when creating new branches (e.g., `.env.local`, config files)

### CLI Changes
- Add `--sync-on-start` flag for config mode - UI now starts immediately without initial sync by default
- Use `--sync-on-start` to restore previous behavior (sync on startup)

### New Services
- `FileCopyService` - handles copying configured files to new branches
- `triggerInitialSync()` public method on `InteractiveUIService`

### Internal Improvements
- Event-based UI communication via `appEvents` utility
- Enhanced logger with UI output function support
- Git service additions: `branchExists`, `createBranch`, `pushBranch`
