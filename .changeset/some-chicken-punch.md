---
"sync-worktrees": minor
---

Added interactive mode for easier configuration

- When run without arguments, the tool now launches an interactive setup wizard
- Prompts users for all required configuration values:
  - Repository path (supports relative paths, automatically converted to absolute)
  - Repository URL (only prompted if the repository doesn't exist)
  - Worktree directory (supports relative paths)
  - Run mode (once or scheduled with cron)
  - Cron schedule (if scheduled mode is selected)
- Shows a configuration summary before proceeding
- Makes the tool more user-friendly for first-time users
- Existing command-line argument usage remains unchanged
