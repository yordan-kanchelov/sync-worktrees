---
question: "What happens when a branch is force-pushed or deleted upstream?"
order: 5
---

Force-pushes are detected and the divergent working copy is moved aside into a `.diverged/` directory rather than overwritten — uncommitted work is never silently lost. Deleted branches have their worktrees removed only if they are clean, with no unpushed commits, no stashes, and no operation in progress; anything else is preserved and surfaced in the TUI's status view.
