# Interactive TUI

Running `sync-worktrees` with no arguments opens the terminal UI; this page covers the home screen's repository table,
every key, the three wizards, the status flags, and how terminal and editor launch is configured. The
[README](../README.md#interactive-tui) has the nine keys you will use most.

The UI has a per-repository table, live log streaming, manual sync triggers, and wizards for the common operations. It
syncs once on startup (see `defaults.syncOnStart` in the [configuration reference](./configuration.md#whole-file-settings)) and then on the
cron schedule; `s` triggers the same cycle by hand. Cycles do not pile up on one repository: a tick that finds a
repository already syncing skips that repository and says so in the log. While the status line reads `Syncing...`, `s`,
`r` and `x` do not act; the key legend briefly reads "A sync is in progress" instead. A tick the machine slept through
is not replayed — the next tick, or an `s`, runs the cycle. There is no headless mode: without `--run-once` this
UI is what runs (when stdin or stdout is not a terminal it exits 1 and says to use `--run-once`), so leave it open in a
`tmux` or `screen` window if you want it to keep going after you close the terminal (see
[Running it unattended](../README.md#running-it-unattended)).

## Home screen

The screen opens on a table with one row per repository, the log under it and the status bar at the bottom.

| Column      | Shows                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| STATE       | `● idle`, `⟳ syncing`, `✗ failed` (the sync threw, a sync action failed, or the repository lock could not be taken) or `⚠ skipped` (another sync or process held the repository) |
| REPOSITORY  | The repository's `name` (or `repo-N`)                                                                                         |
| LAST RESULT | What the last sync did (`2 created, 1 removed`, `up to date`), why it failed (first line of the error) or why it was skipped  |
| SYNCED      | How long ago the last sync ran to an end (`just now`, `3m ago`, `5h ago`); it keeps counting while the screen is open. A skip leaves it alone |
| WT          | Worktrees the repository has, as of its last sync or status check                                                             |
| CHANGES     | `M2 ↑1`: worktrees with uncommitted changes and with unpushed commits, `✓` for none, `–` until known                          |
| NEXT        | Time until the repository's next scheduled run; `–` for `runOnce` or no schedule                                              |

Nothing in the table runs git while it is drawn. The worktree count is read once per repository after each sync, and
the CHANGES column is the result of the last status check of that repository in the worktree status view (`w`), so it
stays `–` until you have opened that view for it and is as fresh as that check.

The table takes the rows it needs first, but leaves the log at least a few lines. `l` folds the log to a single line
(its entry count and the latest entry, in red or yellow for an error or warning) and gives the table the room; `l`
again brings it back. `+` grows the log and `-` shrinks it, three rows at a time: holding `+` hands the whole screen to
the log, and `-` past the smallest panel folds it. When there are more repositories than rows, the last row counts the
rest and says how many of them failed or are syncing.

In a narrow terminal the table drops columns rather than wrapping, in this order: NEXT, WT, CHANGES, SYNCED, then LAST
RESULT; STATE and REPOSITORY always stay. In a short one the log folds to one line on its own, and below that the table
goes. The status bar's key legend shortens to the keys alone (`s c o w x r ?help q`) when the full one does not fit.

The status bar shows:

- **Status** — `Idle` or `Syncing...`.
- **Last Sync** — when the last cycle finished, followed by how it went: `✓ OK`, `✗ 2 failed` (repositories whose sync
  failed; the log has the reasons) or `⚠ 1 skipped` (repositories not synced this time, for example because another
  cycle was already syncing them). A cycle in which every repository was skipped leaves the time where it was but still
  updates the result.
- **Next Sync** — the earliest next run across every schedule, so repositories on different `cronSchedule`s still get
  one. Repositories with `runOnce` have no schedule and do not count.
- **Disk Space** — what the configured bare repositories and worktree directories occupy, refreshed after a sync cycle
  and on reload.

## Keybindings

| Key         | Action                                         |
| ----------- | ---------------------------------------------- |
| `/` / `Ctrl-P` | [Worktree switcher](#worktree-switcher): jump to any worktree in any repository |
| `s`         | Manually trigger sync for all repositories     |
| `c`         | Create a new branch (wizard)                   |
| `o`         | Open a worktree in terminal or editor (wizard) |
| `w`         | View worktree status across repos              |
| `x`         | [Force clean](./trash-and-recovery.md#force-clean-from-the-tui-x): trash, recovery refs, and objects; type `clean` and `Enter` to confirm |
| `r`         | Reload configuration and re-sync               |
| `?` / `h`   | Toggle help screen                             |
| `q`         | Gracefully quit (asks first while work is running) |
| `j` / `↓`   | Scroll log down one line                       |
| `k` / `↑`   | Scroll log up one line                         |
| `PgUp` / `PgDn` | Scroll log one page up / down              |
| wheel       | Scroll the log (hold `Shift` to select text)   |
| `gg`        | Jump to top of log                             |
| `G`         | Jump to bottom (re-enables auto-scroll)        |
| `l`         | Fold the log to one line / bring it back       |
| `+` / `-`   | Grow / shrink the log (the table gets the rest) |

Inside the wizards and the status view, `↑`/`↓` or `Ctrl-P`/`Ctrl-N` move through a list and any other printable key
types into its filter. Keys that act on the selection are ones a filter cannot take: `Enter`, `Tab`, and `Ctrl-D` to
delete a `.diverged/` entry.

The modals size themselves to the terminal: they are never wider than the window, their lists show as many rows as the
height leaves room for, and the help screen drops its spacing and then scrolls (`↑`/`↓`, `j`/`k`, `Ctrl-P`/`Ctrl-N`) when
the window is too short for all of it. The force-clean modal (`x`) shortens its explanation first and then scrolls its
per-repository list with `↑`/`↓` or `Ctrl-P`/`Ctrl-N` (not `j`/`k`, which could be part of the word you type to
confirm).

`Esc` backs out rather than quits: it closes the help screen, cancels a wizard or steps one back to the previous
question, and does nothing on the main screen. `q` is the only key that quits. With nothing running it quits straight
away. While a sync, an `onBranchCreated` hook or a worktree creation is still running, the first `q` names what is
running and a second `q` confirms; any other key cancels. Quitting waits for a running sync (press `q` again to stop
waiting) and terminates any hooks still running (see [Hooks and file copying](./hooks-and-file-copying.md)). `r` and `s`
pressed after that do nothing.

## Worktree switcher

Press `/` or `Ctrl-P` on the main screen. The switcher lists every worktree of every configured repository as `repo › branch` and narrows the list as you type.
Matching is fuzzy: the letters you type have to appear in order but not side by side, so `apilog` finds
`api › feature/login`. Matches that start a word or run together rank higher. Spaces split the query into terms that
must all match, in any order, so `web fix` finds `web › fix/header`. The path of the selected worktree is shown under
the list. Each time it opens, the switcher reads `git worktree list` again for every repository (four at a time), and
worktrees appear as each repository answers. A repository that cannot be listed is named under the list.

| Key                      | Action                                                         |
| ------------------------ | -------------------------------------------------------------- |
| typing                   | Filter; `Backspace` deletes a character, `Ctrl-U` clears it all |
| `↑`/`↓`, `Ctrl-P`/`Ctrl-N` | Move the selection                                           |
| `Enter`                  | Open the selected worktree in the editor                       |
| `Tab`                    | Open the actions menu for the selected worktree                |
| `Esc`                    | Close the switcher                                             |

Every letter goes into the filter, so the per-worktree actions are in a menu that `Tab` opens. `Tab` or `Esc` goes back
to the list with the filter kept. In the menu:

| Key            | Action                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| `e` / `Enter`  | Open in the editor (`$EDITOR` / `$VISUAL`, as in the [Open wizard](#wizards))                                   |
| `t`            | Open a terminal attached to a `tmux` session in the worktree (see [Terminal mode](#terminal-mode-environment-variables)) |
| `y`            | Copy the worktree's path to the clipboard                                                                       |
| `s`            | Sync only this repository. Like `s` on the main screen, it does nothing while a sync is running and says so    |
| `w`            | Open the [status view](#wizards) on this repository with this worktree expanded                                 |

Copying uses `pbcopy` on macOS. On Linux it uses `wl-copy` in a Wayland session, then `xclip` or `xsel`. When none of
them is installed, or the one found fails (for example with no display to talk to), the switcher stays open and shows
the reason with the path, so you can still select the path by hand (hold `Shift` while dragging). The log gets the
same line. A launch that fails keeps the switcher open with the reason, too.

## Wizards

- **Open wizard (`o`)** — select a worktree across all configured repos with live filtering (just type to narrow the
  list). Press `Tab` to flip between **Terminal** mode (launches a new terminal window attached to a `tmux` session in
  the worktree) and **Editor** mode (launches `$EDITOR` / `$VISUAL`, falling back to `code`). Re-opening the same
  worktree attaches to the existing tmux session instead of creating a duplicate. Editor mode needs a **GUI editor**:
  the editor is launched detached with no terminal attached to it, so a terminal editor (`vim`, `nano`, `helix`,
  `emacs -nw`, …) has no TTY to draw on. Those are refused, pointing at Terminal mode (tmux gives an editor a real
  terminal) if an emulator resolves here.
- **Branch creation wizard (`c`)** — pick a repo, pick a base branch from a live-filtered list, type the new branch
  name. Names are validated against Git's rules; if the desired name already exists, a numeric suffix (`-1`, `-2`, …) is
  used automatically — the name shown is the name created. A branch the filters hide has no local worktree but is still
  on the remote, so origin is asked directly and counts as a collision too.
- **Worktree status view (`w`)** — pick a repository (skipped when only one is configured; type to filter), then see
  its worktrees, each tagged with status flags. Type to filter the list by branch; `Esc` goes back to the repository
  choice:

  | Flag | Meaning                                                                                                       |
  | ---- | ------------------------------------------------------------------------------------------------------------- |
  | `✓`  | Clean                                                                                                         |
  | `M`  | Modified / uncommitted changes                                                                                |
  | `↑`  | Unpushed commits                                                                                              |
  | `⇡`  | Commits absent from every remote but fully pushed before the remote branch was deleted (likely squash-merged) |
  | `S`  | Stashed changes                                                                                               |
  | `⚠`  | Operation in progress (merge/rebase/cherry-pick/revert/bisect)                                                |
  | `⊞`  | Modified submodules                                                                                           |
  | `✗`  | Upstream branch is gone                                                                                       |
  | `!`  | Status could not be probed; the reason is on the expanded entry, and the list header counts them              |

  Press `Enter` on an entry to expand file/commit/stash counts. The view also surfaces `.diverged/` directories
  preserved from past force-pushes while trash was disabled (see [Trash and
  recovery](./trash-and-recovery.md#diverged-branches-force-pushes)); press `Ctrl-D` (with `y`/`n` confirmation) to
  delete one after reviewing. It is `Ctrl-D` rather than `d` so that `d` can still be typed into the filter. If the
  delete fails, the reason is shown under the list and the entry stays.

## Terminal mode environment variables

| Variable                  | Purpose                                                                                                                                                                    | Default behavior                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `SYNC_WORKTREES_TERMINAL` | Override the terminal launcher on any platform. Value is a command string ending in the emulator's "run this program" flag; the tmux invocation is appended via `sh -c`. Example: `SYNC_WORKTREES_TERMINAL="alacritty -e"`. Give a bare command and the right flag is supplied for you. | See per-platform defaults below.                                            |
| `TERMINAL`                | Linux-only fallback when `SYNC_WORKTREES_TERMINAL` is unset. Name the emulator only — the exec flag is appended for you.                                                    | Probes `gnome-terminal`, `konsole`, `alacritty`, `kitty`, `xterm` in order. |
| `EDITOR` / `VISUAL`       | Editor mode launcher. Must be a GUI editor (see the Open wizard above).                                                                                                    | Falls back to `code`.                                                       |

All three are split the way a shell would split them, so a path containing spaces can be quoted:
`SYNC_WORKTREES_TERMINAL='"/Applications/My Term.app/Contents/MacOS/term" -e'`. The appended exec flag is chosen per
emulator, because `-e` does not mean the same thing everywhere: `gnome-terminal` and `mate-terminal` take `--`,
`xfce4-terminal` takes `-x`, and everything else takes `-e`.

Per-platform terminal defaults (when no env override is set):

- **macOS** — Ghostty if `Ghostty.app` is installed, otherwise Terminal.app via AppleScript.
- **Linux** — `$TERMINAL` if set; otherwise the first found among the candidates above.

Terminal mode requires [`tmux`](https://github.com/tmux/tmux) to be installed.
