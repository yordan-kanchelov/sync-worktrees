---
"sync-worktrees": patch
---

A shallow clone whose tracked branch was force-pushed onto unrelated history no longer re-runs the whole deepen budget (three extra fetches that cut the clone back and re-download it) on every sync: steps the clone already holds are skipped, so later ticks make only the sync fetch.
