---
"sync-worktrees": minor
---

**A worktree switcher in the TUI: `/` or `Ctrl-P` lists every worktree of every repository and filters as you type.**

- **One list across repositories.** Entries read `repo › branch` and come from `git worktree list` for each configured repository, read afresh each time the switcher opens (four repositories at a time). A repository that cannot be listed is named under the list, and the rest still show.
- **Fuzzy filtering.** The letters you type have to appear in order but not side by side (`apilog` finds `api › feature/login`). Consecutive letters and letters that start a word rank higher, spaces split the query into terms that must all match, and the matched letters are highlighted. `↑`/`↓` or `Ctrl-P`/`Ctrl-N` move, `Ctrl-U` clears the filter and `Esc` closes.
- **Actions.** `Enter` opens the selected worktree in the editor. `Tab` opens a menu for it: `e` editor, `t` terminal (`tmux`), `y` copy the path, `s` sync only that repository and `w` open the status view on that repository with the worktree expanded. The actions sit behind `Tab` because every letter goes into the filter. The editor and terminal launch the same way as in the Open wizard. A repository sync follows the same rules as `s`: it does not start while a sync is running, and it says so.
- **Clipboard.** Copying uses `pbcopy` on macOS and `wl-copy`, `xclip` or `xsel` on Linux. When none is installed or the one found fails, the switcher stays open, shows the reason with the path, and logs it, instead of failing silently.
- The help screen and `docs/tui.md` list the new keys.
