#!/usr/bin/env bash
#
# Renders the 22-second launch video (made with the /brag skill) into assets/launch.mp4, with its poster
# assets/launch-poster.jpg. The product shots are frames cut from assets/demo.mp4, so render the terminal demo first
# (demo/render.sh) whenever the TUI changes.
#
#   demo/launch/render.sh
#
# Needs: node + npm (Playwright and the fonts are installed into a scratch directory), python3 with numpy (the
# soundtrack is synthesized by music.py), ffmpeg, and a Chromium (CHROME_PATH, or Playwright's own download).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/demo/launch"
DEMO="$ROOT/assets/demo.mp4"

for tool in node npm python3 ffmpeg; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done
python3 -c "import numpy" 2>/dev/null || { echo "missing: numpy for python3 (pip install numpy)" >&2; exit 1; }
[[ -f "$DEMO" ]] || { echo "missing: $DEMO (run demo/render.sh first)" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$SRC/index.html" "$SRC/render.mjs" "$SRC/music.py" "$WORK/"
cd "$WORK"

echo "installing Playwright and fonts into $WORK"
npm install --silent --no-audit --no-fund --prefix "$WORK" playwright-core@1.56 @fontsource/inter@5 @fontsource/jetbrains-mono@5 >/dev/null
mkdir -p fonts
cp node_modules/@fontsource/inter/files/inter-latin-{400,500,600,700}-normal.woff2 fonts/
cp node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-{400,500}-normal.woff2 fonts/

# The two product shots, cut from the terminal demo at 30 fps. The offsets follow demo/story.tape: the TUI's
# dashboard and `/` switcher (4.4 s), then the `--dry-run` plan (18.3 s). Check them if the storyboard changes.
mkdir -p demoA demoB
ffmpeg -v error -y -ss 4.4 -t 3.4 -i "$DEMO" -vf "fps=30,crop=1000:664:0:0" -q:v 2 demoA/%04d.jpg
ffmpeg -v error -y -ss 18.3 -t 3.0 -i "$DEMO" -vf "fps=30,crop=1000:520:0:0" -q:v 2 demoB/%04d.jpg

echo "synthesizing the soundtrack"
python3 music.py

echo "rendering frames"
node render.mjs frames 30 22

# Poster: the settled headline frame (6.5 s). It also replaces frame 0, so every player's thumbnail shows it
# without changing the duration or the audio sync.
ffmpeg -v error -y -i frames/00195.png -q:v 2 "$ROOT/assets/launch-poster.jpg"
cp frames/00195.png frames/00000.png

ffmpeg -v error -y -framerate 30 -i frames/%05d.png -i soundtrack.wav \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -profile:v high -movflags +faststart \
  -c:a aac -b:a 192k -shortest "$ROOT/assets/launch.mp4"

echo "assets/launch.mp4: $(du -h "$ROOT/assets/launch.mp4" | cut -f1)"
echo "assets/launch-poster.jpg: $(du -h "$ROOT/assets/launch-poster.jpg" | cut -f1)"
