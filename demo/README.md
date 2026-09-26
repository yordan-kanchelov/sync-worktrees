# Demo recording

The README GIFs (`assets/demo-dark.gif`, `assets/demo-light.gif`) and the site's hero video (`assets/demo.mp4` plus
its poster `assets/demo-poster.webp`) are rendered with [VHS](https://github.com/charmbracelet/vhs) from the tapes in
this directory, against a fixture that needs no network.

```bash
pnpm build && demo/render.sh
```

| File                 | What it does                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `story.tape`         | The storyboard: config, dashboard, switcher (`/`), status view (`w`), one folder per branch, `--dry-run`, `--run-once`, `cd` |
| `demo.tape`          | Dark theme (Catppuccin Mocha); also writes the site video and poster                             |
| `demo-light.tape`    | The same with a light theme (Catppuccin Latte); keep its settings in step with `demo.tape`       |
| `setup-fixture.sh`   | Builds `/tmp/demo`: bare `frontend`/`backend` remotes over `file://`, fixed dates, and a config  |
| `upstream-change.sh` | Pushes `feature/payments` and deletes `feature/login` upstream, between the two syncs            |
| `render.sh`          | Puts this checkout's CLI on `PATH`, runs the tapes, shrinks the GIFs with gifsicle               |

Requirements: `vhs` (which needs `ttyd`, `ffmpeg` and Chromium), `tree`, `gifsicle`, the JetBrains Mono font and an
emoji font. When running as root (for example in a container), set `VHS_NO_SANDBOX=true`.

The [Demo workflow](../.github/workflows/demo.yml) re-renders on every push to `main` that touches `demo/` or the TUI
(`src/components/`), and on demand, and opens a pull request with the new assets.
