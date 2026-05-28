# Demo recording

Scripts to (re)record the README's demo GIF.

## One-time setup

```bash
brew install asciinema agg gifsicle tmux
```

## Record

```bash
# from repo root
./demo-recording/record-demo.sh
./demo-recording/convert-to-gif.sh
```

`record-demo.sh` will:

1. Clean the `demo-recording/fixture/` directory if present.
2. Build the project if `dist/` is missing.
3. Print a 3-second countdown and start asciinema, which launches `demo.sh`.
4. `demo.sh` runs the TUI against `demo-recording/sync-worktrees.config.js` (two repos: `github/gitignore` in worktree mode, `octocat/Hello-World` in clone mode).

## Keystrokes during recording

Wait for the log to show both repos synced (~5–10s), then:

| Step | Key | Why |
|------|-----|-----|
| 1 | `w` | Worktree status view — pause ~4s so flags are readable |
| 2 | `Esc` | Back to log |
| 3 | `o` | Open wizard |
| 4 | type `fea` | Demonstrate live filter |
| 5 | `Tab` | Flip Terminal ↔ Editor mode |
| 6 | `Esc` | Close wizard |
| 7 | `?` | Help modal (~2s) |
| 8 | `Esc` | Close help |
| 9 | `q` | Graceful quit, ends recording |

Aim for ≤30 seconds of recorded time.

## Convert

```bash
./demo-recording/convert-to-gif.sh
```

Writes `assets/sync-worktrees-demo-optimized.gif`. Target ≤500 KB; the script warns if exceeded.

## Files

| File | Purpose |
|------|---------|
| `sync-worktrees.config.js` | Fixture config (two repos, worktree + clone modes) |
| `demo.sh` | Launches the TUI; asciinema executes this |
| `record-demo.sh` | Cleans state, runs asciinema |
| `convert-to-gif.sh` | `.cast` → `agg` → `gifsicle` → final GIF |
| `fixture/` | Created at record time, gitignored |
| `demo-sync-worktrees.cast` | Asciinema raw output, gitignored |
