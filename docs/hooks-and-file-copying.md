# Hooks and file copying

`hooks.onBranchCreated` and `filesToCopyOnBranchCreate` run only when you create a branch yourself from the TUI's branch
wizard; a worktree the sync or the MCP server creates gets neither. This page is the full reference for both; the
[example config](../sync-worktrees.config.example.js) shows them in place, and the [README](../README.md#configuration)
names them.

The wizard-only rule is deliberate: a hook is an arbitrary shell command, and running one unattended on every cron tick
— or on an agent's say-so — is a different thing from running it because a person pressed a key. The one exception is
clone mode's initial copy, below.

If your per-branch bootstrap (`.env.local`, `npm ci`) lives here, a worktree created by the sync or by an agent will not
have it: run those steps yourself after `create_worktree`, or create the branch from the TUI (`c`) and hand the agent
the path.

- `hooks.onBranchCreated` — array of shell commands run after the wizard has created the new branch's worktree.
  Placeholders: `{BRANCH_NAME}`, `{WORKTREE_PATH}`, `{REPO_NAME}`, `{BASE_BRANCH}`, `{REPO_URL}`. Started in the
  background — branch creation does not wait for them — but they do not outlive the interface; see below.
- `filesToCopyOnBranchCreate` — paths copied into the worktree the wizard just created (e.g. `.env.local`, `.npmrc`).
  **In worktree mode the copy source is the base branch's worktree** — the checkout the new branch was cut from — so a
  file is there to be copied only if it is sitting in that checkout. In clone mode the source is the config file's
  directory instead, and the copy fires once on the initial clone rather than from the wizard (clone mode tracks a
  single fixed branch, so there is no later branch-creation event; `hooks.onBranchCreated` still fires only from the
  wizard).

## Pattern rules in detail

Patterns are relative to whichever of those two the source is. A pattern that can reach a path it does not spell out —
one holding a `*` or `**`, a `?`, a character class that admits more than one name, or an extglob, the leading-`!` kind
(`!(dist)/.env`) included — is expanded as a pattern, and skips `node_modules`, `.git`, `dist`, `build`, `.next`,
`coverage`, and this tool's own `.bare/`, `.trash/`, `.removed/`, `.diverged/`, `.sync-worktrees-state/` and
`.sync-worktrees-locks/`; a recursive pattern would otherwise walk straight into them. A pattern that spells its path
out is the one path you named and is copied as named, so `build/local.settings.json` arrives even though `build/` is in
that list.

Braces count as spelling it out: `{build,dist}/x.json` is the two paths `build/x.json` and `dist/x.json` written on one
line, and both arrive. Each alternative is judged on its own, so that holds only while every one of them is itself a
path — `{a.json,**/b.json}` has one that wanders, and the whole pattern is then measured against the list above.

The verdict is glob's own, taken under the options the expansion parses with rather than by hunting for punctuation, and
it parts company with the look of the pattern over a class that admits a single character: `a[1].json` can produce
nothing but `a1.json`, so it counts as spelled out — and glob still reads it as a class, so what it names is `a1.json`
and not a file whose name contains the brackets. Escaping the brackets names that file, and the escape has to survive
the config file as well: it is JavaScript, where `"a\[1\].json"` is just `a[1].json` again, so write `"a\\[1\\].json"`.

A leading `!` is not negation here. The expansion runs with negation off, so `!` is an ordinary filename character —
unlike `sparseCheckout.exclude`, where the gitignore meaning does apply — and `"!node_modules/**"` would quietly look
inside a directory named `!node_modules` and find nothing there. The config loader rejects an entry starting with a bare
`!` rather than let that happen; `!(dist)/.env` is the extglob above and is still allowed, and a file whose name really
does start with `!` is named by escaping it: `"\\!important.json"`.

Neither kind of pattern reads out of a `worktreeDir` or `bareRepoDir` the config file names, the destination included —
reached by that name, or under any other name in the source that resolves to the same directory, through however many
symlinks. Spelling a literal path into one does not get past that: in the documented layout the clone-mode source is the
parent of every checkout, and the other repositories' secrets are not this copy's to take.

A pass that matches nothing logs `matched 0 files for patterns [...] in <source directory>` at info level, so a pattern
aimed at the wrong directory says so instead of looking like the feature was never configured.

## Hook environment and timeout

Hook commands run with the new worktree as their working directory, and with the variables git uses to name a repository
(`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, ...) removed from their environment. Those
variables outrank a working directory, so an inherited one would point a hook's `git` at that repository instead of the
worktree — and git hands its own `GIT_DIR` to hooks run inside a linked worktree, so a run started from one inherits it
with nothing exported by hand. Pass one explicitly in the command itself if a hook really does want it.

`hooks.timeoutMs` bounds how long one hook may run before it is SIGTERMed (SIGKILL 5 seconds later); default 60000, set
on a repository entry or under `defaults` like every other knob, and it must be a whole number of milliseconds from 0 to
2147483647 (`setTimeout`'s ceiling: a larger delay silently becomes a ~1 ms one, so the config refuses it instead). An
install step (`npm ci`, `pnpm install`) on a large repository routinely outruns that default, so raise it — or set `0`,
meaning no timeout — before configuring one. `0` is an explicit choice to run the hook unbounded and unsupervised:
nothing reclaims it if it wedges, short of quitting.

## What happens to hooks when you quit

Quitting terminates every hook still running, naming each one as it does. They cannot be left running instead: a hook's
stdout and stderr are pipes into this process — which is what puts its output in the log panel — so a hook that outlived
the quit would be killed by SIGPIPE at its next write, mid-work and without the chance to clean up that a trapped
SIGTERM gives it. Terminating deliberately is the outcome a hook can act on — and acting on it takes a moment, which
those same pipes would otherwise deny: the exit closes them, so a trap that prints anything is SIGPIPEd part-way
through. So the quit waits up to 250 ms after the SIGTERM, ending the moment the hooks are gone (a hook with no trap
dies on the signal and costs nothing), and SIGKILLs whatever is still there rather than leaving a hook that ignores
SIGTERM running with no parent. Detach the work inside the command itself (`nohup`, `setsid`, `systemd-run`) if it
genuinely has to continue past the quit, at the cost of the captured output.
