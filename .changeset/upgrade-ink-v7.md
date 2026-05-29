---
"sync-worktrees": minor
---

Upgrade Ink to v7 and adopt new TUI capabilities:

- Layout now re-flows live on terminal resize (`useWindowSize`).
- The interactive UI renders in the terminal's alternate screen buffer, restoring prior scrollback on exit, with incremental rendering to reduce flicker (`alternateScreen` + `incrementalRendering`).
- Pasting is supported in the branch-creation, open-editor, and worktree-status views, including multi-character branch names that were previously dropped (`usePaste`).
