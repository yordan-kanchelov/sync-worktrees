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

# 2. The TUI syncs on start: every remote branch becomes a worktree, and the dashboard shows each repository.
Type "sync-worktrees"
Sleep 300ms
Enter
Sleep 2500ms

# 3. `/` opens the switcher: every worktree of every repository, filtered as you type.
Type "/"
Sleep 600ms
Type@120ms "fix"
Sleep 2200ms
Escape
Sleep 300ms

# 4. `w` opens the worktree status view; Enter picks the first repository, Escape backs out one step at a time.
Type "w"
Sleep 800ms
Enter
Sleep 2200ms
Escape
Sleep 200ms
Escape
Sleep 300ms
Type "q"
Sleep 800ms

# 5. One folder per branch, named after it.
Hide
Type "clear"
Enter
Show
Type "tree -L 2 -d"
Sleep 300ms
Enter
Sleep 3s

# 6. Upstream moves on: a teammate pushes feature/payments and deletes feature/login.
Hide
Type "$DEMO/upstream-change.sh /tmp/demo && clear"
Enter
Sleep 1s
Show

# 7. --dry-run shows what the next sync would do, without doing it.
Type "sync-worktrees --dry-run --filter frontend"
Sleep 300ms
Enter
Sleep 3200ms

# 8. The real sync: --quiet keeps it to one line, fit for cron.
Hide
Type "clear"
Enter
Show
Type "sync-worktrees --run-once --quiet && ls frontend frontend/.trash"
Sleep 300ms
Enter
Sleep 2500ms

# 9. The new branch is already a checkout: switching is just `cd`.
Type "cd frontend/feature-payments && git log --oneline -1"
Sleep 300ms
Enter
Sleep 2500ms
