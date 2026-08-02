---
"sync-worktrees": minor
---

Add reversible worktree trash and restore workflows, an explicit TUI force-clean action, and hardened cleanup for detached or external worktrees, stale registrations, unsafe manifests, and interrupted diverged-branch replacement. Worktree status now uses `--ignore-submodules=none`, recursively inspecting every submodule and overriding `submodule.<name>.ignore` and `diff.ignoreSubmodules`; this may increase sync and pruning costs.
