---
"sync-worktrees": patch
---

In the interactive UI, a reload now shows the progress of the repositories it is initializing, and names the one whose initialization failed. `initialize()` — a bare clone for a repository just added to the config, and the longest thing a reload ever waits on — reports through the progress emitter rather than the logger, and the reloaded services were subscribed to it only once every `initialize()` had already resolved; the progress pane stayed empty for the whole of it. Each service is now watched from the moment it is built until its own `initialize()` settles. The failure line, which read `Failed to initialize repository: <git error>`, now carries the repository name taken from the index into the configured list, matching what the run-once path already prints: with several repositories initializing at once a git error such as `Permission denied (publickey)` names nothing the user can find in the config.
