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

## Launch video

`assets/launch.mp4` (with its poster `assets/launch-poster.jpg`) is a 22-second launch video with a soundtrack, made
with the [/brag](https://github.com/latent-spaces/brag) skill for sharing and the site. Its product shots are frames
cut from `assets/demo.mp4`, so re-render it after the terminal demo when the TUI changes:

```bash
demo/launch/render.sh
```

| File                | What it does                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `launch/index.html` | The composition: every frame is a pure function of time (`window.render(t)`)                  |
| `launch/render.mjs` | Screenshots each frame with Playwright                                                        |
| `launch/music.py`   | Synthesizes the soundtrack (A minor, 120 BPM, cuts on the beat) with numpy                    |
| `launch/render.sh`  | Installs Playwright and the fonts into a scratch dir, cuts the demo frames, renders, encodes  |

Requirements: node and npm, python3 with numpy, ffmpeg, and Chromium (`CHROME_PATH`, or Playwright's own download).
The render is deterministic: the same inputs give the same frames. It is not part of the Demo workflow; each
re-render adds about 2.6 MB to the history, so re-render only when the video would visibly change.
