---
"sync-worktrees": minor
---

Display CLI command for future reference

When running sync-worktrees, the tool now displays the exact CLI command that can be used to replicate the current execution. This is shown after configuration is determined (both in interactive and non-interactive modes) and helps users understand how to run the tool directly from the command line with the same parameters.

The command is displayed in the format:
```
📋 CLI Command (for future reference):
   sync-worktrees --repoPath "/path/to/repo" --worktreeDir "/path/to/worktrees" --runOnce
```