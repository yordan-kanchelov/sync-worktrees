---
"sync-worktrees": patch
---

The worktree status view no longer leaves the selection on the "Diverged Directories" separator or past the end of the list: a repository with only diverged entries, a filter matching only diverged entries, or deleting the last diverged entry now keeps a row selected, so Enter and Ctrl-D work without pressing Down first.
