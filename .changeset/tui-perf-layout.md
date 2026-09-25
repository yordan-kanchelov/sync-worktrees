---
"sync-worktrees": minor
---

TUI: log lines are batched into one render every 50ms instead of one render (and a copy of the whole log buffer) per
line, and the status bar and log panel no longer re-render for updates that do not concern them. Modals size themselves
to the terminal: they are never wider than the window, their lists use the rows the window has instead of a fixed
eight, and the help screen compacts and then scrolls on short terminals. Deleting a `.diverged/` entry in the status
view is now `Ctrl-D` (was `d`), so `d` can be typed into the filter; lists also accept `Ctrl-N`/`Ctrl-P`. The unused
`LogViewer` component is removed.
