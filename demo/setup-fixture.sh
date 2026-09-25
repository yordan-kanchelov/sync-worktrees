#!/usr/bin/env bash
#
# Builds the offline fixture the demo tapes record against:
#
#   $DEMO_ROOT/                  used as $HOME while recording
#   ├── .gitconfig               a neutral commit identity
#   ├── remotes/frontend.git     bare "remote" repositories, reached over file:// (no network)
#   ├── remotes/backend.git
#   └── work/
#       └── sync-worktrees.config.js
#
# Commits use a fixed identity and fixed dates, so every run produces the same SHAs.
#
# Usage: demo/setup-fixture.sh [DEMO_ROOT]    (default /tmp/demo; wiped first)

set -euo pipefail

DEMO_ROOT="${1:-${DEMO_ROOT:-/tmp/demo}}"
REMOTES="$DEMO_ROOT/remotes"
WORK="$DEMO_ROOT/work"

case "$DEMO_ROOT" in
  /tmp/?* | /var/tmp/?* | "${RUNNER_TEMP:-/nonexistent}"/?*) ;;
  *)
    echo "refusing to use '$DEMO_ROOT': it is wiped first, so it must live under /tmp, /var/tmp or \$RUNNER_TEMP" >&2
    exit 1
    ;;
esac

rm -rf "$DEMO_ROOT"
mkdir -p "$REMOTES" "$WORK"

export HOME="$DEMO_ROOT"
export TZ=UTC
export GIT_CONFIG_NOSYSTEM=1
unset GIT_CONFIG_GLOBAL XDG_CONFIG_HOME GIT_DIR GIT_WORK_TREE

cat >"$DEMO_ROOT/.gitconfig" <<GITCONFIG
[user]
	name = Alex Rivera
	email = alex@example.com
[init]
	defaultBranch = main
[advice]
	detachedHead = false
GITCONFIG

# Each commit is one minute after the previous one, starting from a fixed instant.
TICK=1767261600 # 2026-01-01T10:00:00Z
commit() {
  TICK=$((TICK + 60))
  GIT_AUTHOR_DATE="@$TICK +0000" GIT_COMMITTER_DATE="@$TICK +0000" git commit --quiet -m "$1"
}

# change <file> <line> <message>: append one line to a file and commit it.
change() {
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >>"$1"
  git add "$1"
  commit "$3"
}

# make_repo <name> <function>: build history in a scratch repo, push every branch to a bare remote.
make_repo() {
  local name="$1" seed="$DEMO_ROOT/.seed-$1"
  git init --quiet --bare "$REMOTES/$name.git"
  git init --quiet "$seed"
  (
    cd "$seed"
    "$2"
    git remote add origin "$REMOTES/$name.git"
    git push --quiet --all origin
  )
  rm -rf "$seed"
}

frontend_history() {
  change README.md "# frontend" "Initial commit"
  change src/app.tsx "export const App = () => null;" "Add app shell"
  change src/header.tsx "export const Header = () => null;" "Add header"

  git checkout --quiet -b feature/login main
  change src/login.tsx "export const Login = () => null;" "Add login form"
  change src/login.tsx "// validate email" "Validate email on login"

  git checkout --quiet -b feature/search main
  change src/search.tsx "export const Search = () => null;" "Add search box"

  git checkout --quiet -b fix/header main
  change src/header.tsx "// sticky" "Make header sticky on scroll"

  git checkout --quiet -b feature/dark-mode main
  change src/theme.ts "export const dark = {};" "Add dark theme tokens"

  git checkout --quiet main
}

backend_history() {
  change README.md "# backend" "Initial commit"
  change api/server.go "package api" "Add HTTP server"
  change api/users.go "package api" "Add users endpoint"

  git checkout --quiet -b feature/rate-limit main
  change api/ratelimit.go "package api" "Add token bucket rate limiter"

  git checkout --quiet -b fix/n-plus-one main
  change api/users.go "// preload orders" "Preload orders in users query"

  git checkout --quiet -b release/v2 main
  change CHANGELOG.md "## v2" "Prepare v2 release"

  git checkout --quiet main
}

make_repo frontend frontend_history
make_repo backend backend_history

cat >"$WORK/sync-worktrees.config.js" <<CONFIG
export default {
  repositories: [
    {
      name: "frontend",
      repoUrl: "file://$REMOTES/frontend.git",
      worktreeDir: "./frontend",
    },
    {
      name: "backend",
      repoUrl: "file://$REMOTES/backend.git",
      worktreeDir: "./backend",
    },
  ],
};
CONFIG

# The tick counter continues in upstream-change.sh, so its commit is deterministic too.
echo "$TICK" >"$DEMO_ROOT/.tick"
