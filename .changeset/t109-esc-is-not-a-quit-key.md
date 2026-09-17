---
"sync-worktrees": patch
---

`Esc` is documented as what it is — the back-out key — and no longer advertised as a second way to quit the TUI.

The README keybindings table and the help screen both listed `` `q` / `Esc` `` against "Gracefully quit", and the main screen never honoured it: `App`'s `useInput` has a `key.escape` branch only while the help screen is open, and its main-screen chain tests `q`, `?`/`h`, `c`, `o`, `w`, `x`, `s` and `r` by `input` alone. Writing a lone `\x1b` to a rendered `App` never called `onQuit`. So a user who read either list and pressed `Esc` got nothing, with no way to tell a key that did not work from a quit that was taking its time.

Resolved in favour of the code rather than the documentation, because `Esc` already has a job here and it is not this one. It closes the help screen, cancels the open-editor wizard, cancels and un-answers the branch-creation wizard a question at a time, steps the worktree status view back to the project list, and dismisses the force-clean modal. Several of those go back rather than out, so `Esc` is the key a user presses in runs — and quitting is immediate, has no confirmation step, and terminates any hooks still running. Binding an exit to the key that is pressed repeatedly to retreat would turn one `Esc` too many, or a key that repeated under a held finger, into a torn-down daemon and a hook killed mid-work. `q` stays the one deliberate key, alone in the help screen's quit row and alone in the README table, and the keybindings section now says outright what `Esc` does and that `q` is the only key that quits.

The drift is guarded at the level it drifted at. `HelpModal`'s tests asserted that the help text rendered and that the modal's own keys closed it; nothing asserted that a key the modal advertised did anything on the screen that owns it, which is exactly how a line of documentation and a chain of `else if` came apart. The new pins are in `App`'s suite, where the key is handled: `Esc` on the main screen leaves `onQuit` uncalled and the interface rendering, and — the case that made the decision — a second `Esc` straight after the one that closed the help screen does not quit either. `HelpModal`'s suite gains the one text assertion that is worth making, reading the rendered quit row and requiring that it names `q` and not `Esc`.

No behaviour changed for anyone: the key did nothing before this and does nothing now. What changed is that the two places that described it now match it.
