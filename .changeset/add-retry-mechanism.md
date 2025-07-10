---
"sync-worktrees": minor
---

Add retry mechanism for network and filesystem operations

- Added configurable retry mechanism with exponential backoff for handling transient failures
- Sync operations now automatically retry on network errors (ECONNREFUSED, ENOTFOUND, ETIMEDOUT) and filesystem errors (EBUSY, ENOENT, EACCES)
- Added retry configuration options:
  - `maxAttempts`: Number of retry attempts or "unlimited" (default: 3)
  - `initialDelayMs`: Initial delay between retries (default: 1000ms)
  - `maxDelayMs`: Maximum delay between retries (default: 30s)
  - `backoffMultiplier`: Exponential backoff multiplier (default: 2)
- Retry configuration can be set globally, in defaults, or per repository
- Added logging for retry attempts to help with debugging transient failures