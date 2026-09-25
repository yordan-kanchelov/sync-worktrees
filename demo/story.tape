# The storyboard shared by demo.tape (dark) and demo-light.tape (light); they differ only in theme and output.
# Not meant to be rendered on its own: run demo/render.sh from the repository root.

# Offline fixture (demo/setup-fixture.sh): two bare "remote" repositories and a config, with $HOME at /tmp/demo.
Hide
Type "export DEMO=$PWD/demo HOME=/tmp/demo LANG=C.UTF-8 TZ=UTC GIT_CONFIG_NOSYSTEM=1"
Enter
Type "$DEMO/setup-fixture.sh /tmp/demo && cd ~/work && unset PROMPT_COMMAND && PS1='\[\e[2m\]\w\[\e[0m\] $ ' && clear"
Enter
Sleep 1s
Show

# 1. One config file declares the repositories.
Type "cat sync-worktrees.config.js"
Sleep 300ms
Enter
Sleep 2200ms

# 2. The TUI syncs on start: every remote branch becomes a worktree.
Type "sync-worktrees"
Sleep 300ms
Enter
Sleep 2500ms

# 3. `w` opens the worktree status view; Enter picks the first repository, Escape backs out one step at a time.
Type "w"
Sleep 1s
Enter
Sleep 2800ms
Escape
Sleep 200ms
Escape
Sleep 300ms
Type "q"
Sleep 800ms

# 4. One folder per branch.
Hide
Type "clear"
Enter
Show
Type "tree -L 2 -d"
Sleep 300ms
Enter
Sleep 3s

# 5. Upstream moves on: a teammate pushes feature/payments and deletes feature/login.
Hide
Type "$DEMO/upstream-change.sh /tmp/demo && clear"
Enter
Sleep 1s
Show

Type `sync-worktrees --run-once | grep -E "✅ (Created|Moved)"`
Sleep 300ms
Enter
Sleep 2500ms
Type "ls frontend frontend/.trash"
Sleep 300ms
Enter
Sleep 2500ms

# 6. The new branch is already a checkout: switching is just `cd`.
Type "cd frontend/feature-payments && git log --oneline -1"
Sleep 300ms
Enter
Sleep 2500ms
