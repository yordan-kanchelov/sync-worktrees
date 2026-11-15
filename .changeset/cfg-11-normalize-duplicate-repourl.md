---
"sync-worktrees": patch
---

Duplicate `repoUrl` detection now treats URLs that differ only by a trailing `.git`, slash or host case as the same repository, so the second entry gets its own `.bare/<name>` instead of failing the config. The bareRepoDir collision error no longer calls two different repositories that share a basename "duplicate repoUrl entries".
