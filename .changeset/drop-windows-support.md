---
"sync-worktrees": minor
---

Drop Windows support. The platform was never exercised in CI and hooks already refused to run there because cmd.exe shell quoting is unsafe. `package.json` now declares `os: ["darwin", "linux"]` so `npm install` warns Windows users. Removes `win32` branches from the terminal launcher, hook execution guard, case-insensitive FS check, and worktree list CRLF stripping.
