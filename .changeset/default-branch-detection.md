---
"sync-worktrees": patch
---

Automatically detect and use the repository's default branch instead of hardcoding "main". The tool now:
- Detects the default branch from the repository's HEAD reference
- Falls back to common branch names (main, master, develop, trunk) if detection fails
- Works correctly with repositories using different default branch names