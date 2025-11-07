---
"sync-worktrees": minor
---

Add improvements to support parallel operations

- Add total concurrency validation to prevent resource exhaustion. Configs now validate that total concurrent operations (maxRepositories × per-repo limits) don't exceed safe limit of 100.
- Add exponential backoff with jitter support to prevent thundering herd problem in concurrent Git operations. Configure via `retry.jitterMs` option.
