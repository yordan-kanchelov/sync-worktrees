---
"sync-worktrees": patch
---

Stop treating an uninitialized submodule as a modified one. `git worktree add` never initializes submodules, so every worktree of a repo with a `.gitmodules` entry reported git's "not initialized" marker and was permanently skipped as "modified submodules": never pruned, never narrowed by sparse-checkout, and always flagged `⊞` in the TUI. Only a submodule whose checked-out commit differs from the index or that has merge conflicts blocks removal now, and the reported list holds submodule paths instead of object ids.
