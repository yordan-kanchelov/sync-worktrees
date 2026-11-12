---
"sync-worktrees": patch
---

A diverged worktree moved to trash or `.diverged/` kept a `.git` link to the replacement's registration, so git run inside the copy acted on the live branch, and the printed recovery steps told you to do exactly that. The copy's link is now renamed to `.git.detached`, the recovery text points at the bare repository and the real trash id, and `.diverged-info.json` no longer comes back as an untracked file after `trash restore`.
