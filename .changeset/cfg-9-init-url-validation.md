---
"sync-worktrees": patch
---

The `init` wizard rejected repository URLs that a config file accepts, such as `git://` URLs, scp-style URLs with a user other than `git`, and local paths. It now validates with the same rule as the config loader.
