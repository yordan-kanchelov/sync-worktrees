---
"sync-worktrees": minor
---

feat(progress): emit clone/fetch progress to logger

Long bitbucket clones and fetches felt like a hang because the TUI showed `Cloning from "..."` and then went silent for minutes while git negotiated the pack and resolved deltas. Output was being captured by simple-git but never surfaced.

Changes:
- `GitService` now wires simple-git's `progress` plugin and passes `--progress` to `git clone` and `git fetch`. Per-stage events (`receiving`, `resolving`, `compressing`, `writing`) are throttled to one log line every 25% so the TUI keeps a live "↳ clone receiving: 50% (12345/24690)" trail without flooding the log.
- Applies to bare clone (`initialize`), the post-init `--all` refresh, `fetchAll`, and `fetchBranch`.
- Per-call `progressState` reset between fetches so the same stage reports fresh buckets each run.
