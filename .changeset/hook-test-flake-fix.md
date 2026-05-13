---
"sync-worktrees": patch
---

Stabilize the hook-execution test suite by awaiting actual child-process completion via the `onComplete` callback instead of a fixed 500 ms sleep, removing a flake that surfaced under the full parallel test run.
