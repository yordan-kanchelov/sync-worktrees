---
"sync-worktrees": patch
---

With `skipLfs: true`, worktree status probes (the update gate, prune checks and `check-ignore`) now run git with the full sanitized process environment instead of only `GIT_LFS_SKIP_SMUDGE`, so the global excludes file (`~/.config/git/ignore`, `core.excludesFile`), `~/.gitconfig` (`safe.directory`) and `PATH` are honoured again; globally-ignored files such as `.DS_Store` no longer mark every worktree as dirty, blocking updates and prunes. The sparse-checkout LFS verification client gets the same unsafe-env allowances as every other git client, so a `GIT_ASKPASS` or `GIT_CONFIG_COUNT` in the environment no longer makes it skip the `lfs ls-files` check.
