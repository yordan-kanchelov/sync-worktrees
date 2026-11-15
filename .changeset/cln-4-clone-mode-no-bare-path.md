---
"sync-worktrees": patch
---

Clone-mode repositories no longer derive a bare-repository path from `repoUrl`: a URL with no repository path segment (such as `https://git.example.com`) now syncs instead of failing every run, and the TUI header's disk total no longer counts a stray `.bare/<name>` directory for clone-mode repositories.
