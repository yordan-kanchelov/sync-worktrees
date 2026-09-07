---
"sync-worktrees": patch
---

LFS verification no longer sleeps up to 30 seconds per created worktree: `git worktree add` (and `git clone`) return with their checkout finished, so the files are read once and a single actionable warning names the worktree instead of a wait that could never change the answer — a first sync of 100 branches whose LFS content stayed pointers cost ~50 minutes of sleeping. Verification is also skipped entirely when `GIT_LFS_SKIP_SMUDGE` is exported in the environment (pointers are then expected) and when HEAD's `.gitattributes` declare no `filter=lfs`, and a machine without git-lfs is probed and warned about once per process rather than once per worktree.
