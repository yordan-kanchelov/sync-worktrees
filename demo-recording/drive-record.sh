#!/usr/bin/env bash
#
# drive-record.sh — start asciinema inside detached tmux pane, drive TUI via tmux send-keys.
#
# One-shot script for automated recording. Use this when you want a hands-off rerecord;
# for manual driving, use record-demo.sh.
#
# Tmux session name: swt-demo. Will refuse to run if a session by that name already exists.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SESSION="swt-demo"
CAST="$SCRIPT_DIR/demo-sync-worktrees.cast"
COLS=100
ROWS=28

cd "$REPO_ROOT"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Refusing to overwrite existing tmux session '$SESSION'." >&2
  exit 1
fi

rm -f "$CAST"

# Launch asciinema in detached tmux session.
tmux new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" \
  "cd '$REPO_ROOT' && asciinema rec --quiet --overwrite --command '$SCRIPT_DIR/demo.sh' '$CAST'"

cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for TUI to render (look for "Running" status text or the keybinding hint).
echo "→ waiting for TUI to render..."
for ((i = 0; i < 30; i++)); do
  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Session died before TUI rendered." >&2
    exit 1
  fi
  pane=$(tmux capture-pane -t "$SESSION" -p)
  if echo "$pane" | grep -q "Running"; then
    echo "→ TUI ready at ${i}s"
    break
  fi
  sleep 1
done

# Trigger manual sync. The CLI sets up cron but does not auto-trigger initial sync.
sleep 1
echo "→ s (manual sync)"
tmux send-keys -t "$SESSION" "s"

# Wait for "Syncing..." state to appear (sync started).
saw_syncing=0
for ((i = 0; i < 30; i++)); do
  pane=$(tmux capture-pane -t "$SESSION" -p)
  if echo "$pane" | grep -q "Syncing"; then
    saw_syncing=1
    echo "→ sync started at ${i}s"
    break
  fi
  sleep 1
done
if (( saw_syncing == 0 )); then
  echo "WARNING: never observed 'Syncing' state after pressing s." >&2
fi

# Wait for it to return to "Running" (sync done).
for ((i = 0; i < 180; i++)); do
  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Session died during sync." >&2
    exit 1
  fi
  pane=$(tmux capture-pane -t "$SESSION" -p)
  if echo "$pane" | grep -q "Running" && ! echo "$pane" | grep -q "Syncing"; then
    echo "→ sync done at +${i}s"
    break
  fi
  sleep 1
done

# Brief breathing room before first keystroke so the "Running" frame is visible.
sleep 2

# Initialization + syncing demo only. No wizards/help modal — the sync activity is
# the story; viewers want to see log stream + status flip from Syncing → Running.
# The sync-poll loop above already covered s → Syncing → Running. Linger so the
# final "Running" state stays on screen for ~3 seconds, then quit.

sleep 3

echo "→ q (quit)"
tmux send-keys -t "$SESSION" "q"

# Wait for asciinema to exit cleanly (tmux session ends with demo.sh).
for ((i = 0; i < 20; i++)); do
  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    break
  fi
  sleep 1
done

if [[ ! -s "$CAST" ]]; then
  echo "Cast file missing or empty at $CAST" >&2
  exit 1
fi

size_kb=$(($(stat -f%z "$CAST" 2>/dev/null || stat -c%s "$CAST") / 1024))
echo ""
echo "→ recorded $CAST (${size_kb} KB)"
echo "→ next: ./demo-recording/convert-to-gif.sh"
