---
"sync-worktrees": minor
---

Scroll the log panel with the mouse wheel. `j`/`k`, the arrows, `gg` and `G` all still work — the wheel is for people who don't reach for vim motions. Mouse tracking is enabled while the TUI is running and turned back off on exit; hold `Shift` to select text with the mouse as usual. Mouse reports are ignored everywhere else in the UI, so scrolling over a filter box no longer types an escape sequence into it.
