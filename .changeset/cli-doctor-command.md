---
"sync-worktrees": minor
---

Add `sync-worktrees doctor`: checks the Node.js and git versions, git-lfs (when a synced repository uses LFS), that the config file is found and valid, and for each repository that `repoUrl` answers a non-interactive `git ls-remote --heads`, that its directories and lock/state directories are writable, and that there is free disk space. Prints one PASS/WARN/FAIL line per check with a fix hint (`--quiet` keeps only problems, `--json` prints an array), honours `--filter` and `NO_COLOR`, and exits 1 only when a check failed.
