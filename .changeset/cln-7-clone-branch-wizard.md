---
"sync-worktrees": patch
---

Clone-mode branch wizard: a name nested under an existing local branch (e.g. `feat/sub` with `feat` present) now fails once with the blocking ref named instead of retrying ten suffixed names; a branch a failed push could not roll back stops the suffix retry; the config-drift warning names the configured branch rather than the previous in-session one; and `filesToCopyOnBranchCreate` no longer warns "Could not find worktrees for file copy".
