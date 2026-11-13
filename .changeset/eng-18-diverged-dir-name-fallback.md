---
"sync-worktrees": patch
---

When a `.diverged` copy's `.diverged-info.json` could not be read, its branch was shown with the directory's hash and unique suffix still attached (`feat-two-2a383c54-mwd95i8ughnw3`). Both suffixes are now stripped, so it shows as `feat-two`.
