---
"sync-worktrees": patch
---

`SyncWorktreesMaintenanceConfig` is now exported from the package's public types like the other config-block aliases, and the published declarations no longer include internal service types (only `public-types.d.ts` and the config types it re-exports ship).
