---
"sync-worktrees": patch
---

The published package no longer ships JS source maps or `.d.ts.map` declaration maps (156 files / 2.6 MB unpacked down to 80 files / under 1 MB), and `pnpm smoke` now fails if maps come back or the tarball outgrows its file-count and size ceilings.
