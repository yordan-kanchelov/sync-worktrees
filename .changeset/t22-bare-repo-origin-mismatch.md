---
"sync-worktrees": patch
---

Worktree mode now checks that an existing bare repository's `origin` is the configured `repoUrl` (compared ignoring `.git`, a trailing slash and scheme/host case) before fetching from it. On a mismatch — a migrated host, a fork swapped for upstream — initialization fails with `CONFIG_ORIGIN_MISMATCH`, naming both URLs (credentials redacted) and suggesting `git -C <bareRepoDir> remote set-url origin <repoUrl>` or a fresh `bareRepoDir`, instead of silently syncing the old remote; `--runOnce` exits 1.
