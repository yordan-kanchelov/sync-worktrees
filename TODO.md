# Code Review TODO — 2026-09-03

Whole-application review of sync-worktrees at commit `c7388d8` (v5.3.1): the worktree-mode sync
pipeline, clone mode, the git service layer, trash/removal safety, config loading and the CLI, the
MCP server, the Ink TUI, process-level concerns (locking, signals, hooks, child processes), plus
cross-cutting sweeps for documentation drift, CI/build tooling, test infrastructure and security.
It continues `REVIEW_FINDINGS.md` (F1–F20, all done) with `T`-numbered items. Each item is a
self-contained task spec: an agent should be able to implement it from this document alone.

Conventions used below:

- **Location** — primary files/lines (line numbers as of commit `c7388d8`).
- **Current behavior** — what the code does today, with the failure scenario.
- **Expected behavior** — the spec to implement.
- **Acceptance** — how to verify (tests to add/adjust). All existing tests must keep passing;
  run `pnpm lint && pnpm typecheck && pnpm test`.
- **Notes** — verification details, constraints the fix must respect, duplicate reports merged
  into the item.

Status legend: `[ ]` open · `[x]` done · `[~]` needs product decision first.

## Progress checklist

Implementation order follows the batches at the end of this document, with Batch 8 first because T51
(lint TypeScript) surfaces findings that every code batch would otherwise churn on. Each task is
implemented by a worker agent, reviewed by an independent reviewer agent until approved, then
squash-merged into this PR as one commit. An item is ticked here and in its heading when it lands.
Items marked `[~]` wait on the product decisions listed near the end of the document.

### Batch 8 — CI, tooling and packaging

- [x] **T51** — `pnpm lint` never lints TypeScript: the eslint glob covers 6 root JS files, so all
  75 source and 77 test `.ts`/`.tsx` files ship unlinted and the CI 'Run Linter' step is a no-op for
  the app
- [x] **T52** — PR workflow `paths` filter omits `**.tsx`, `**.cjs`, `**.mjs` and
  `.github/actions/**`, so a PR that only changes Ink components (18 `.tsx` files) or the composite
  setup action runs no lint, typecheck, build or tests
- [ ] **T118** — Prettier is configured (`.prettierrc`) but not installed, has no script, and is
  never enforced in CI
- [ ] **T119** — CI only exercises Node 24 while `engines` promises `>=22.0.0`; the minimum
  supported runtime (and the ESM module-detection behaviour that differs across 22.x) is never tested
- [ ] **T120** — No post-build smoke test: CI builds `dist/` but never executes the CLI or imports
  the MCP bundle, so a bundling regression is only caught after publish
- [ ] **T121** — Published package ships 156 files / 2.6 MB unpacked, including `.d.ts.map` files
  and JS sourcemaps with the full TypeScript source embedded via `sourcesContent`

### Batch 1 — guardrails, small and isolated

- [ ] **T1** — Capability gate for sync/initialize (and create/update) is bypassed after any
  mutating tool: ensureCapability treats a null discovered context as 'allowed' and
  invalidateDiscovered() nulls it
- [ ] **T38** — sync tool reports success:true when the sync outcome recorded failures
  (counts.failed > 0); the CLI treats the same outcome as exit code 1
- [ ] **T40** — create_worktree can move an unregistered directory at the target path into .trash
  (or rm -rf it when trash is disabled) although it is annotated destructiveHint:false and the README
  says the MCP surface cannot remove or touch trash
- [ ] **T30** — All cross-process locking, git inactivity timeouts, trash reaping and gc are
  silently disabled whenever the inherited environment has NODE_ENV=test; the CLI only sets NODE_ENV
  when it is unset
- [ ] **T10** — Lock-directory preparation failure is misreported as 'another process holds the
  lock', counted as a skip, and runOnce exits 0 having synced nothing
- [ ] **T5** — With skipLfs:true every status probe runs git with an env of only
  {GIT_LFS_SKIP_SMUDGE:1} — global gitignore/config ignored, PATH lookup broken (5.3.1 env fix missed
  this site)
- [ ] **T50** — Repository URLs are echoed verbatim in logs, the `list` command, error messages and
  MCP responses, so a `https://user:TOKEN@host/repo.git` credential leaks into terminal scrollback,
  TUI log buffers and agent transcripts
- [ ] **T22** — Worktree mode never checks that an existing bare repo's origin URL matches
  config.repoUrl (clone mode does), so a changed repoUrl silently keeps syncing the old remote
- [ ] **T21** — initialize() creates the default-branch worktree with a raw `worktree add` and
  treats git's 'already exists' as success; a pre-existing unregistered directory leaves the service
  pointed at a non-repository and every later sync fails at fetch
- [ ] **T49** — Git subprocesses never set GIT_TERMINAL_PROMPT=0 (or SSH BatchMode): in the TUI a
  credential prompt is written into the alternate screen and the fetch blocks until the 300 s
  inactivity timeout instead of failing immediately with an actionable message
- [ ] **T47** — Cross-process repo lock is keyed on XDG_STATE_HOME/HOME, so a daemon and a
  shell-launched run can hold different lock files for the same worktreeDir (clone mode then has no
  lock at all); lock also lives under ~/.cache
- [ ] **T29** — No validation that two repositories share (or overlap) a worktreeDir: the second
  entry silently trashes the first entry's worktrees and adopts its default-branch checkout, while
  both report 'synced'

### Batch 2 — worktree-mode create/update correctness

- [ ] **T17** — Bare clone leaves stale refs/heads/* copies of every remote branch; the 'local &&
  remote' worktree-add path checks out that stale tip and the same sync never fast-forwards it
- [ ] **T18** — Default-branch detection is frozen to a dangling `refs/remotes/origin/HEAD`; after
  the remote renames its default branch every sync fails in the update phase and the old default is
  never pruned
- [ ] **T3** — Worktrees without an upstream (trash restore, MCP create_worktree push=false,
  'without tracking' fallback) are never fast-forwarded and are reported as already_up_to_date forever
- [ ] **T63** — isWorktreeBehind uses @{upstream} while canFastForward/updateWorktree use
  origin/<branch>: a differing upstream yields a phantom 'updated/fast_forward' outcome every sync
- [ ] **T6** — A transient probe failure in canFastForward/isLocalAheadOfRemote is interpreted as
  'diverged' and can move a healthy, fully pushed worktree to trash and recreate it
- [ ] **T9** — Long-lived process never recovers when the default-branch worktree is deleted
  out-of-band: every later sync fails with 'spawn git ENOENT'
- [ ] **T19** — Unpushed-commit probe uses the bare branch name as a revision; a tag with the same
  name shadows the branch and reports 0 unpushed commits with exit 0
- [ ] **T20** — Uninitialized submodules (`-` status) are classified as 'modified submodules', so
  every worktree of a repo with submodules is permanently un-prunable, flagged ⊞, and blocked from
  sparse narrowing
- [ ] **T24** — removeWorktree only classifies git's 'dirty' refusal; locked worktrees and worktrees
  with initialized submodules turn into hard `remove_failed` failures (exit 1) every tick, and the
  `locked` flag parsed from `worktree list` is discarded
- [ ] **T23** — `fetchTimeoutMs` is applied as an inactivity kill to every command on cached clients
  (worktree add checkout, ff-merge, checkout HEAD, status); `worktree add` is silent during checkout,
  so large-repo creation is SIGINT'd after 5 min and can never succeed
- [ ] **T4** — LFS-skip retry is wired only to fetchAll, where LFS never fails; per-worktree
  checkout LFS failures are swallowed by Promise.allSettled and repeat every tick
- [ ] **T8** — LFS verification sleeps up to 30 s per created worktree, serialized, although nothing
  can change the files after `worktree add` returns (F18 left the wait in place)
- [ ] **T62** — Remote branches ending in '/HEAD' (and ambiguous refname:short cases) are dropped
  from the sync inventory, so their worktrees are pruned as stale
- [ ] **T77** — A detached-HEAD managed worktree is reported and counted as a freshly created
  worktree on every sync
- [ ] **T78** — Dead and silently broken git wrappers: `localBranchExists` always returns true and
  `hasDivergedHistory` always returns false (simple-git swallows silent exit-1); several other exports
  are unused
- [ ] **T81** — An interrupted bare clone (SIGKILL/power loss) leaves a HEAD-less bareRepoDir that
  makes every later initialize fail with git's 'destination path already exists' and no recovery path
- [ ] **T64** — Sparse reconcile (Step 5) is not idempotent for includes with a trailing slash:
  re-applies patterns and runs `git checkout HEAD` on every worktree every sync
- [ ] **T2** — Update phase spawns ~6 git processes per worktree every tick (4 + 6W per sync)
  including a full `git status` scan before the cheap tip comparison; one `for-each-ref` already
  answers 'nothing changed'
- [ ] **T53** — MAX_SAFE_TOTAL_CONCURRENT_OPS validation counts each status check as one process,
  but every getFullWorktreeStatus spawns 6 git processes in parallel (240 at default settings)
- [ ] **T54** — `update_check_failed` skip and its log line carry no branch or path, so the user
  cannot tell which of N worktrees failed the probe
- [ ] **T55** — GitService.updateLogger does not reach WorktreeStatusService/WorktreeMetadataService
  or cached progress handlers, so in the TUI their log lines bypass the log panel and go to the raw
  console
- [ ] **T56** — Per-worktree simple-git client caches are never evicted (GitService ×2 variants +
  WorktreeStatusService): ~20 KB retained per branch lifetime in daemon mode
- [ ] **T57** — `git check-ignore` after `git status --porcelain -u` is a redundant spawn per dirty
  worktree (status never lists ignored paths) and passes every untracked path as argv
- [ ] **T58** — isPathInsideBaseDir uses synchronous existsSync/realpathSync per registered worktree
  and re-resolves worktreeDir every call (≈41 ms of blocked event loop per sync at 400 worktrees)
- [ ] **T60** — Phase progress emits exactly 5 events per attempt with no processed/total, so the
  TUI and MCP progress show a static message during long create/prune/update phases

### Batch 3 — clone mode

- [ ] **T12** — Adopting a directory whose `.git` is a gitdir pointer (linked worktree / submodule)
  rewrites the PARENT repository's fetch refspec and deletes its remote-tracking refs
- [ ] **T13** — A clone that fails after fetch ("Clone succeeded, but checkout failed", e.g. LFS
  smudge error) is left in place and silently adopted as a valid clone on the next run; sync then
  reports `dirty_tree` forever
- [ ] **T14** — LFS smudge failure during clone-mode ff-merge: retry policy's LFS-skip override is
  never honored by clone-mode git clients, and the failed merge leaves stray files that turn every
  later tick into a permanent `dirty_tree` skip
- [ ] **T15** — `fetch --unshallow` is the only fetch without `--progress`; with stderr piped it is
  silent until completion, so simple-git's 300 s inactivity timeout kills any unshallow that takes
  longer — the repo can never unshallow and every tick hard-fails
- [ ] **T16** — TUI branch-creation wizard cannot create branches for clone-mode repos:
  createAndPushBranch targets a nonexistent bare repo path, so clone-mode branch switching (CHANGELOG
  5.0.0) is unreachable
- [ ] **T72** — TUI reports the worktree-mode constant 'main' as the default branch of clone-mode
  repos (F10 fix incomplete: only the MCP handler was corrected)
- [ ] **T73** — checkoutBranch on a shallow clone throws FastForwardError when merge-base is merely
  indeterminate (duplicated, diverging fast-forward logic vs classifyRemoteRelationship)
- [ ] **T67** — Clone-init pending marker is written after `configureSingleBranchRemote`, so a crash
  in that window leaves a marker-less valid clone whose file copy is silently dropped forever
  (contradicting the comment at 659-662)
- [ ] **T68** — Clone-mode sparse re-apply skips the README's "narrowing safety" check and does not
  record failures/skips in the sync outcome, unlike worktree mode
- [ ] **T66** — With a small configured `depth`, every routine sync re-passes `--depth N` and
  re-shortens the history the previous tick deepened; at `depth: 1` every remote advance (even +1
  commit) is indeterminate and costs a 50-commit deepen fetch, then is thrown away
- [ ] **T71** — Clone-mode sync runs a full `git status` scan every tick before learning the clone
  is already up to date; a dirty but current clone is reported as a skip instead of up-to-date
- [ ] **T74** — configureSingleBranchRemote rewrites .git/config twice and scans remote refs on
  every sync tick although the fetch never uses the stored refspec
- [ ] **T75** — Stale remote-tracking refs are deleted one `git update-ref -d` process per ref
  instead of a single batched `update-ref --stdin`
- [ ] **T76** — Clone-mode syncs produce no per-phase timing in --debug (PhaseTimer is only wired
  into the worktree-mode runner)
- [ ] **T65** — `sanitizeGitEnv` forwards repository-discovery variables (`GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_INDEX_FILE`, ...); when sync-worktrees is launched from a git hook,
  clone-mode's config rewrites, ref deletions and merges target the hook's repository instead of
  `worktreeDir`
- [ ] **T69** — `filesToCopyOnBranchCreate` globs walk every sibling repository checkout under the
  config directory and copy their files into the new clone
- [ ] **T70** — The destructive `rm -rf` branch of `maybeCleanupPartialClone` has no test; only the
  negative (EACCES) case asserts `fs.rm` is not called

### Batch 4 — trash, diverged and removal safety

- [ ] **T26** — F7 fix incomplete: trash entries written by 5.0.x/5.1.0 (flat pin refs) are rejected
  as invalid manifests forever — never listed, never restorable, never reaped, pin refs never released
- [ ] **T27** — A partially failed `fs.rm` of a trash container deletes manifest.json first and
  leaves an unrecognized, unreapable container whose pin ref is then kept forever
- [ ] **T28** — TUI force clean purges trash entries created after the confirmation preview: a cron
  sync that starts while the modal is open can trash worktrees that are then destroyed with gc
  --prune=now without ever being shown to the user
- [ ] **T11** — fs.cp in the cross-device diverged path (and trash restore) rewrites relative
  symlinks to absolute source paths that are then deleted, leaving dangling links in the
  preserved/restored copy
- [ ] **T7** — Trash moves run `du` over the whole worktree (node_modules included) under the repo
  lock before the 8 ms rename; size is informational only
- [ ] **T82** — Compare-and-swap branch deletion (`update-ref -d`) leaves the `[branch "<name>"]`
  remote/merge section in the bare repo config for every trashed worktree, growing .bare/config
  without bound
- [ ] **T83** — Legacy `.diverged/` adoption ignores the entry's `keep/<name>` ref: the permanent
  keep ref stays after the directory is moved into trash, and the payload's .diverged-info.json still
  points at a recovery flow that no longer applies
- [ ] **T84** — Force clean runs `git gc --prune=now` on a shared object store without checking for
  in-flight git operations, while the modal text says active worktrees are untouched
- [ ] **T85** — Manifest `branch` is not validated as a ref name; a hand-edited or corrupted
  manifest with an option-like branch makes restore run `git branch -m <sha>` and rename the bare
  repo's HEAD branch
- [ ] **T86** — Permanent keep refs accumulate one per squash-merged branch with no expiry, no batch
  removal, and O(N) fsync'd audit writes + git spawns in force clean
- [ ] **T87** — Worktree restore copies the whole payload (fs.cp) and then rm's the container
  instead of renaming it into place — O(size) I/O and 2x disk during restore
- [ ] **T89** — `sync-worktrees trash` CLI ergonomics: no size/branch/restorable columns, silent on
  empty trash, expected errors print as 'Unhandled error' stack traces, restore fails fast when the
  daemon holds the lock, no single-entry purge, and a files-only restore is silently re-trashed by the
  next sync
- [ ] **T90** — No real-git coverage for trash restore or force clean: restoreAsWorktree,
  legacy-manifest compatibility and purge are only exercised with stubbed GitService / mocked
  purgeAllUnlocked

### Batch 5 — config loading, CLI and init

- [ ] **T31** — The shipped sync-worktrees.config.example.js fails validation
  ('experimental-features' sets runOnce) — the README's reference for 'every knob' cannot be loaded
- [ ] **T32** — Per-repository `parallelism` is never validated (F9 fix only covered
  global/defaults): a non-positive-integer value passes load and makes every sync throw TypeError from
  p-limit
- [ ] **T33** — `fetchTimeoutMs` / `cloneTimeoutMs` are documented on Config and promised by README
  but are silently dropped by resolveRepositoryConfig — no config-file user can change the 5/15-minute
  inactivity timeouts
- [ ] **T34** — `sync-worktrees init` reports success but writes configs that cannot be loaded: ESM
  syntax into a `.cjs` target or into a `"type": "commonjs"` package, and `worktreeDir: "./"` when the
  worktree dir equals the config dir
- [ ] **T35** — Config hot-reload is stale for ESM configs that import sibling modules: only the
  top-level module is cache-busted, so TUI `r` and MCP `load_config` keep the first-loaded values of
  `./repos.js`-style imports
- [~] **T36** — Daemon/TUI mode never syncs at startup and no CLI/config option restores it:
  `--sync-on-start` was removed in 4.0.0 without a replacement, while README says the bare command
  'starts syncing'
- [ ] **T91** — Load-time validation gaps with runtime consequences: `branchInclude: [""]` prunes
  every non-default worktree, NaN/Infinity retry numbers pass and make retry() throw,
  `skipUpdateWhenOutsideSparse` accepts a string that inverts its meaning
- [ ] **T92** — Unknown / misspelled config keys are silently ignored at runtime (typo'd
  `updateExistingWorktree`, `branchIncludes`, `fetchTimeoutMs` load without a warning)
- [ ] **T93** — CLI error reporting loses context: init failures omit the repository name, every
  runtime error is labelled 'Error loading config file', `trash` errors dump a raw stack, and config
  SyntaxErrors lack file/line
- [ ] **T94** — Docs drift in shipped user-facing text: example config's lock-file location is
  wrong, README's CLI section omits the `trash` subcommand
- [ ] **T95** — Dead or duplicated constants in src/constants.ts: unused
  GIT_CONSTANTS/DEFAULT_CONFIG/METADATA entries, FETCH_CONFIG duplicated as a literal in
  git.service.ts, test-only TEST_TIMEOUT shipped in dist, unused CliCommand type
- [ ] **T96** — Test coverage gaps in the config/CLI subsystem: example config never loaded, no
  per-repo parallelism or ESM-split reload case, runOnce init-rejection and locked-skip accounting
  untested, daemon branch of runMultipleRepositories untested, init round-trip only covers the happy
  path
- [ ] **T79** — F9(3) incomplete: `extractRepoNameFromUrl` still rejects URL shapes `isValidGitUrl`
  accepts (`git://`, https with trailing slash), and the validator rejects legal scp URLs with a
  non-`git` user
- [ ] **T80** — Sparse-checkout patterns are not validated at load time; cone-mode includes with a
  leading slash (or wildcards) are rejected by git, so every worktree creation fails and is rolled
  back on every tick
- [ ] **T61** — README states retry.maxAttempts defaults to 'unlimited' but the sync policy defaults
  to 3; DEFAULT_CONFIG.RETRY constants are bypassed (jitter 500 vs 0)

### Batch 6 — MCP server

- [ ] **T37** — create_worktree silently creates worktrees the next sync will move to trash:
  branches excluded by branchInclude/branchExclude/branchMaxAge, and push:false local-only branches
  (whose local branch ref is deleted too)
- [~] **T39** — Tool input schemas are non-strict: unknown/misspelled arguments (repo_name,
  include_status, branch_name…) are silently stripped, so calls run against the wrong repo or with
  defaults instead of failing
- [ ] **T97** — Auto-detect derives worktreeDir as dirname(current worktree); from inside the
  default-branch worktree of a repo whose default branch contains '/' this is wrong and
  create_worktree/update_worktree fail in initialize() with a git 'already checked out' error
- [ ] **T98** — update_worktree on a detached-HEAD worktree: membership passes or fails depending on
  cache state, fetchBranch is called with the pseudo-branch '(detached abc1234)', and updateWorktree
  would merge origin/<sha>
- [ ] **T99** — A found-but-broken auto-discovered config is invisible to the agent: detectFromPath
  logs to stderr, reports kind 'unmanaged'/configPath null, and re-imports the broken file on every
  subsequent detect_context
- [ ] **T100** — detect_context with includeStatus + includeAllWorktrees enriches the current repo's
  worktrees twice (allWorktrees and allWorktreesByRepo[current]) — ~10 git spawns per worktree
  duplicated; discovery/repo caches never evict
- [ ] **T101** — list_worktrees per-worktree cost: getDivergence duplicates upstream/rev-list work
  already done inside getFullWorktreeStatus (≈10-11 git spawns per worktree, ~4,400 processes for 400
  worktrees per call)
- [ ] **T102** — Nested regular repos / submodules inside a managed worktree make detect_context
  return 'unsupported' instead of continuing to the enclosing worktree
- [ ] **T103** — MCP tool/instruction text and README drift: '.ts' configs are advertised but never
  discovered or loadable; README still says repo selection falls back to 'the first entry in the
  config'; list_worktrees fallback error blames initialization when the bare repo is simply missing
- [ ] **T104** — create_worktree cannot tell the agent that the worktree already existed, yet is
  annotated idempotentHint:false; response shape hides the no-op
- [ ] **T105** — MCP handler tests never exercise RepositoryContext and handlers together; the
  ctx/service contract is fully mocked, so state-machine regressions (capability bypass, membership
  cache drift) are invisible
- [~] **T59** — No dry-run/plan surface: the planner is pure but there is no CLI or MCP way to
  preview what a sync will create, prune or update before it mutates

### Batch 7 — TUI and process lifecycle

- [ ] **T41** — Concurrent sync cycles share one TUI status flag: the first cycle to finish (cron
  group, overlapping tick, or a fail-fast skip) flips the UI to idle, wipes the running cycle's
  progress rows and re-enables the `s`/`x`/`r` guards
- [ ] **T42** — Ctrl+C in the TUI unmounts Ink (default `exitOnCtrlC`) but never runs `destroy()`:
  the process keeps running headless with cron syncs, log events go nowhere, and a second Ctrl+C then
  kills it mid-sync
- [ ] **T43** — `MOUSE_TRACKING_DISABLE` is never written on any exit path (q, SIGTERM, Ctrl+C): Ink
  marks itself unmounted before React effect cleanups run, so `useStdout().write` in App's cleanup is
  a no-op and the shell inherits a terminal with mouse reporting on
- [ ] **T44** — Branch wizard acts on stale refs and its collision check is decorative: it submits
  the unsuffixed name, `createBranch` only detects local heads, `push -u` can silently fast-forward an
  existing remote branch, and a failed push leaves an orphan local branch that makes the next attempt
  create `<name>-1`
- [ ] **T45** — OpenEditorWizard and WorktreeStatusView re-run their loader forever when it returns
  an empty list (no `loaded` guard), spinning React renders and git/fs calls while the modal is open
- [ ] **T46** — LogPanel exceeds its height budget by 1-2 rows in the steady state (plus one row per
  embedded newline), so the App frame is taller than the terminal and Ink falls back to a
  full-terminal clear on every render, scrolling the top row off
- [ ] **T25** — TUI worktree status view fans out getFullWorktreeStatus over every worktree with no
  concurrency limit (≥6 git processes each)
- [ ] **T88** — TUI runs `du` over every bare repo and every worktreeDir after every sync cycle (and
  on each status view open), a full-tree stat walk per tick that is never cached or throttled
- [ ] **T106** — WorktreeStatusView repository sizes get stuck at `calculating...` when the App
  re-renders while `du` is in flight (effect cleanup discards the result; `repositories` prop is a new
  array on every App render)
- [ ] **T107** — Pressing `q` during a long sync freezes the TUI for up to 30 s with no feedback,
  then exits mid-sync anyway: `destroy()` sets `isDestroyed` before waiting, so its own 'Waiting for N
  in-progress sync(s)' and timeout warning are dropped by `addLog`
- [ ] **T108** — Reload (`r`) initializes the new services before injecting the UI logger, so
  clone/fetch/init output and warnings of the reload go to the raw console instead of the log panel
- [ ] **T109** — Docs/help drift: README and the help modal say `Esc` quits, but the main screen
  ignores Esc; README quick start says the TUI 'starts syncing' while the daemon never syncs until the
  first cron tick and no `syncOnStart` option remains
- [ ] **T110** — Quitting the TUI SIGTERMs (then SIGKILLs) the whole process group of every
  in-flight `onBranchCreated` hook (e.g. `npm install` in the new worktree) — undocumented,
  contradicts 'fire-and-forget'
- [ ] **T111** — Editor mode spawns `$EDITOR` detached with stdio ignored, so terminal editors
  (vim/nvim/nano/emacs -nw — the most common `$EDITOR` values) silently do nothing while the wizard
  reports success and closes
- [ ] **T112** — `$TERMINAL=gnome-terminal` (and other `$TERMINAL`/`SYNC_WORKTREES_TERMINAL` values
  needing `--`) is launched with `-e sh -c <cmd>`, which the probe path already knows is wrong for
  gnome-terminal; command strings are split on whitespace so paths with spaces break
- [ ] **T113** — NODE_ENV=test silently disables the cross-process lock, and the e2e double-run test
  (spawning dist under the inherited NODE_ENV=test) therefore never exercises locking; no test
  anywhere runs two real processes against one repo
- [ ] **T114** — onBranchCreated hooks are killed at a hard-coded, undocumented 60 s timeout (the
  example config's own `pnpm install` hook routinely exceeds it); `setTimeoutMs` is never wired to
  config, and completion logs omit which hook finished
- [ ] **T115** — Repository initialization failures are logged without the repository name in both
  runOnce and reload paths, so with parallel init the user cannot tell which repo failed
- [ ] **T116** — FileCopyService silently applies a hard-coded ignore list (dist/, build/, .next/,
  coverage/, …) even to explicit file patterns, swallows glob errors, and a zero-match copy produces
  no log line at all
- [ ] **T117** — Reload/cancel stops cron tasks with `stop()` but never `destroy()`s them; node-cron
  v4's module-level registry retains every stopped task (and, through its closure, every previous
  generation of WorktreeSyncService instances) for the life of the daemon
- [~] **T48** — Docs drift: README says hooks/file copy run for every newly created worktree and
  that copy globs resolve relative to the config directory; in code both fire only from the TUI branch
  wizard, and the TUI copies from the base-branch worktree (clone mode: config dir) — sync- and
  MCP-created worktrees never get either

## Summary

**Headline.** 121 open items (1 high, 51 medium, 69 low) across every subsystem, on a codebase whose
lint, typecheck, build and 1558-test suite are all green. The one high item is an MCP guardrail
bypass (T1). Nothing found is an active data-loss path on a default configuration — the trash and
pin-ref machinery from 5.2.x holds — but several items turn 'reversible' into 'stranded' (T26, T27,
T28, T11) and several make the tool silently do less than it reports (T38, T10, T36, T48).

**Themes.**
- *MCP and process guardrails*: capability checks vanish after any mutating tool (T1); `sync`
  reports success on failed outcomes (T38); `create_worktree` can trash an unregistered directory
  despite the README's no-removal promise (T40); an inherited `NODE_ENV=test` disables locking and
  timeouts (T30); the cross-process lock is keyed by `HOME`/`XDG_STATE_HOME` (T47); credentials in
  `repoUrl` are echoed everywhere (T50).
- *Worktree-mode correctness*: a bare clone's frozen `refs/heads/*` copies make newly admitted
  branches start at a stale tip and read as 'diverged' (T17) — the root of several confusing
  behaviours; a renamed default branch fails every sync forever (T18); worktrees without an upstream
  never update (T3); a transient probe error is treated as divergence and can trash a healthy
  worktree (T6); the inactivity timeout meant for fetch kills long checkouts and merges (T23).
- *Clone mode*: adopting a linked worktree or submodule rewrites the parent repository's remote
  config (T12); a clone that failed at checkout is adopted as valid forever (T13); the LFS-disabled
  retry never reaches clone-mode clients (T14); `--unshallow` cannot survive the silent timeout (T15).
- *Trash and removal safety*: pre-5.1.1 trash entries are stranded by F7's ref layout (T26); a
  partially failed reap leaves an unreapable container with a permanent pin (T27); force clean
  purges entries the user never previewed (T28); `fs.cp` turns relative symlinks into dangling
  absolute ones on cross-device moves and restores (T11).
- *Performance*: roughly six to ten git processes per worktree per tick before anything changes
  (T2, T25, T57), a pointless 30 s LFS wait per created worktree (T8), `du` under the repo lock and
  after every cycle (T7, T88), and unbounded fan-out in the TUI (T25, T45).
- *Workflow and docs*: `pnpm lint` does not lint TypeScript (T51) and the PR workflow skips
  `.tsx`-only changes (T52); the shipped example config does not load (T31); `init` can write a
  config that cannot be imported (T34); the daemon never syncs until the first cron tick (T36); the
  README promises hooks and file copies for every created worktree while only the TUI wizard runs
  them (T48).

**Quick wins** (small diffs, high value): T1, T5, T8, T10, T19, T20, T30, T31, T38, T49, T50, T51,
T52. **Product decisions first**: T36, T39, T48, T59.

**Caveat.** This is an automated multi-agent audit. Every item was de-duplicated and re-read by the
coordinating reviewer against the cited code, but the three cross-cutting sweeps (documentation
vs. behaviour, CI/tooling, security) ran at reduced depth — the dedicated review agents for those
areas were cut off by usage limits, so their coverage rests on the coordinator's own checks and on
what the subsystem reviewers reported incidentally. Expect more documentation drift than is listed.

---

## High severity

### [ ] T1. Capability gate for sync/initialize (and create/update) is bypassed after any mutating tool: ensureCapability treats a null discovered context as 'allowed' and invalidateDiscovered() nulls it

- **Category**: guardrail · **Subsystem**: mcp
- **Severity**: High · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/mcp/handlers.ts:46-53` (`ensureCapability`), `src/mcp/handlers.ts:64-70`
  (`getReadyService`), `src/mcp/handlers.ts:389, 435, 480, 506` (`ctx.invalidateDiscovered() call
  sites`), `src/mcp/context.ts:270-275` (`RepositoryContext.invalidateDiscovered`),
  `src/mcp/context.ts:757-760` (`RepositoryContext.getDiscoveredContext`), `src/mcp/context.ts:534,
  565-585` (`detectFromPathUncached synthetic auto-detect config`), `README.md:130` (`auto-detect
  mode: 'sync and initialize require a loaded config'`)
- **Current behavior**: In auto-detect mode (no config; the README's default install)
  detectFromPathUncached registers a synthetic RepoEntry {repoUrl, worktreeDir: dirname(cwd
  worktree), bareRepoDir, runOnce:true} and stores capabilities sync/initialize = {available:false,
  reason:'no config file loaded (running in auto-detect mode)'} on entry.discovered. The only
  enforcement is ensureCapability(discovered, key), which starts with `if (!discovered) return;`.
  Every mutating handler (create_worktree line 389, sync 435, update_worktree 480, initialize 506)
  calls ctx.invalidateDiscovered(), which since the F8 fix sets entry.discovered = undefined for ALL
  entries. getDiscoveredContext() then returns null and the gate is silently skipped. Failure
  scenario: Server started with cwd inside an unmanaged worktree (repoUrl present). Agent calls
  update_worktree {path: cwd} (allowed) → invalidateDiscovered(). Agent then calls sync {} →
  getDiscoveredContext() === null → ensureCapability returns → ctx.getService() builds a
  WorktreeSyncService on the synthetic config → service.sync() runs a FULL worktree-mode sync
  against an unconfigured repository: fetch --all --prune, create worktrees for every remote branch
  under dirname(cwd worktree) (no branchInclude/branchMaxAge filters, no parallelism limits from any
  config), prune clean worktrees whose branches were deleted upstream into <parent>/.trash,
  diverged-replace, trash reaper and `git gc` maintenance. initialize {} likewise runs
  GitService.initialize() (may create a default-branch worktree at the guessed location). The tool
  description and README both state sync/initialize require a loaded config.
- **Expected behavior**: Capability decisions for mutating tools must not depend on a cache that
  mutating tools clear. Derive them from durable state: for entries with source === 'detected', sync
  and initialize are always CAPABILITY_UNAVAILABLE (reason: 'repository is not in a loaded config;
  call load_config or detect_context from a configured workspace'), create/update require
  entry.config.repoUrl. If discovered is null for a config-source entry, either re-run
  detectFromPath(entry.discovered?.currentWorktreePath ?? launchCwd) before deciding or treat null
  as 'unknown → deny for destructive tools'. Never `return` on null in ensureCapability for
  sync/initialize. Also make the reason text accurate after load_config loaded a config that does
  not cover the detected repo (currently still says 'no config file loaded').
- **Acceptance**: 1) New handler test using the REAL RepositoryContext (fixture as in
  context.test.ts) with mocked WorktreeSyncService: detectFromPath(unmanaged worktree) →
  handleUpdateWorktree → handleSync must return code CAPABILITY_UNAVAILABLE and service.sync must
  not be called; same for handleInitialize. 2) Unit test: ensureCapability/getReadyService with
  discovered === null and entry.source === 'detected' throws for sync/initialize. 3) Existing
  handlers tests keep passing; add a test that a config-source entry with discovered null still
  allows sync. 4) README/tool description remain true: sync/initialize require config.
- **Notes**: Re-verified: `getDiscoveredContext` returns `entry.discovered ?? null`
  (context.ts:757-760), `invalidateDiscovered` sets it to undefined (270-275) after
  create/update/sync/initialize/load_config, and `ensureCapability` returns early on null
  (handlers.ts:46-53). For an auto-detected pseudo-entry, `getService` then builds a service from
  the synthetic config (`worktreeDir = dirname(current worktree)`, context.ts:566-580) and `sync`
  runs a full create/prune/update cycle that was declared unavailable.

---

## Medium severity

### [ ] T2. Update phase spawns ~6 git processes per worktree every tick (4 + 6W per sync) including a full `git status` scan before the cheap tip comparison; one `for-each-ref` already answers 'nothing changed'

- **Category**: performance · **Subsystem**: worktree-sync
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/worktree-mode-sync-runner.ts:797-847`
  (`WorktreeModeSyncRunner.updateExistingWorktrees (Phase 4a)`),
  `src/services/git.service.ts:1150-1170` (`GitService.isWorktreeBehind`),
  `src/services/git.service.ts:1172-1179` (`GitService.updateWorktree`),
  `src/services/git.service.ts:1215-1250` (`GitService.canFastForward / isLocalAheadOfRemote`),
  `src/services/git.service.ts:344-355` (`GitService.getRemoteBranches`),
  `src/services/git.service.ts:1057-1072` (`GitService.getRemoteBranchTips`),
  `src/services/worktree-status.service.ts:99-121` (`WorktreeStatusService.checkWorktreeStatus`),
  `src/services/__tests__/worktree-update.test.ts:82-107, 135-157` (`tests encoding the current call
  order`)
- **Current behavior**: Per sync attempt in steady state (W registered worktrees, every branch still
  on the remote, nothing changed): repo-level spawns are `fetch --all --prune` (runner:253), `git
  branch -v -r` (getRemoteBranches; simple-git injects `-v`, node_modules/simple-git branchTask),
  `worktree list --porcelain` (runner:63), `for-each-ref` tips (runner:415) = 4. Then for EVERY
  worktree Phase 4a runs: `git status --porcelain -b -u` (runner:811 -> status service:101),
  `merge-base HEAD origin/X` + `rev-parse HEAD` (canFastForward), then `git branch -v` + `rev-parse
  --abbrev-ref X@{upstream}` + `rev-list --count` (isWorktreeBehind) = 6 spawns (+1 `check-ignore`
  when untracked files exist, +1 `sparse-checkout list` with sparseCheckout, +2 more
  merge-base/rev-parse for non-ff). Total ≈ 4 + 6W; W=400 → ~2,400 git processes per tick. `git
  status` (a full working-tree lstat walk) is executed before any check of whether origin/X even
  moved, and `git branch -v` (lists all local branches with tracking info) is spawned in
  isWorktreeBehind/updateWorktree only to learn the branch name the runner already holds in
  `worktree.branch`. Failure scenario: Daemon with 400 worktrees on a monorepo, hourly cron, nothing
  pushed since last tick. Measured on the scratch repo (401 local tracking branches, 20k files):
  status 35 ms + merge-base 3 + rev-parse 2 + branch -v 11 + rev-parse @{upstream} 3 + rev-list 3 =
  57 ms and 6 processes per worktree → ~23 s of git CPU/IO per tick just to conclude nothing changed
  (on a real 200k-file monorepo `git status` alone is seconds per worktree, i.e. many minutes per
  tick, while holding the repo lock so the next cron tick is skipped with 'Another repository
  operation is already in progress'). One `git for-each-ref --format='%(refname)%00%(objectname)'
  refs/heads refs/remotes/origin` in the bare repo took 26 ms for 802 refs and already tells which
  branches differ from their remote.
- **Expected behavior**: 1) Add a bare-repo batch probe (extend getRemoteBranchTips to return both
  `refs/heads/*` and `refs/remotes/origin/*` oids in one for-each-ref). 2) In Phase 4a, when
  heads[X] === remotes[X], record `already_up_to_date` with zero per-worktree git calls. 3) For the
  remaining branches, classify with ONE spawn: `git rev-list --left-right --count
  refs/heads/X...refs/remotes/origin/X` in the bare repo (0/N → behind, N/0 → ahead, N/M →
  diverged), replacing canFastForward + isLocalAheadOfRemote + isWorktreeBehind. 4) Run `git
  status`/hasOperationInProgress only on worktrees classified behind or diverged. 5)
  `updateWorktree(path, branch)` takes the branch and drops the `branch()` call. Also replace
  `getRemoteBranches`' `git branch -v -r` with the same for-each-ref data.
- **Acceptance**: Runner test with 3 worktrees where only one branch's remote tip differs:
  `checkWorktreeStatus`/status is invoked exactly once (for that worktree) and no
  merge-base/branch/rev-parse calls are made for the two unchanged ones; outcome still reports 2
  `already_up_to_date` noops and 1 `fast_forward` update. Update worktree-update.test.ts:82-107 and
  135-157 (they currently assert `checkWorktreeStatus` called 3 times and `isWorktreeBehind` only
  for clean ones). Add a spawn-budget test: with N unchanged worktrees the number of simple-git
  `raw`/`branch`/`status` invocations per attempt is constant (≤ 5) independent of N. Manual:
  `debug: true` timing table for a 400-worktree repo shows Phase 4 in the low hundreds of ms when
  nothing changed.
- **Notes**: Re-verified: the Phase 4a probe chain per worktree is fs.access →
  hasOperationInProgress (fs) → checkWorktreeStatus (git status, plus check-ignore when untracked
  files exist) → canFastForward (merge-base + rev-parse) → isWorktreeBehind (branch + rev-parse +
  rev-list). `getRemoteBranchTips` already runs one `for-each-ref` per sync; comparing each
  worktree's recorded `lastKnownRemoteTip` with the current tip answers 'nothing changed' before any
  per-worktree spawn. Also reported as: “Every per-worktree probe runs simple-git branch() = `git
  branch -v -a`, listing/annotating all local+remote refs; cost scales O(worktrees x refs)”.

### [ ] T3. Worktrees without an upstream (trash restore, MCP create_worktree push=false, 'without tracking' fallback) are never fast-forwarded and are reported as already_up_to_date forever

- **Category**: correctness · **Subsystem**: worktree-sync
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/git.service.ts:1150-1170` (`GitService.isWorktreeBehind`),
  `src/services/worktree-mode-sync-runner.ts:814-825` (`Phase 4a canFastForward → isWorktreeBehind →
  noop`), `src/services/trash.service.ts:505-511` (`TrashService.restoreAsWorktree (createBranchAt +
  addWorktreeNoCheckout)`), `src/services/git.service.ts:918-921, 953-958, 718-725` (`createBranchAt
  / addWorktreeNoCheckout / '(without tracking)' fallback`),
  `src/services/__tests__/git-update.test.ts:86-97` (`'should return false when no upstream is
  configured'`)
- **Current behavior**: Phase 4a decides 'can fast-forward' with `merge-base HEAD origin/<branch>`
  (explicit remote ref) but decides 'is behind' with `rev-parse --abbrev-ref <branch>@{upstream}`
  and returns false on any error, including 'no upstream configured'. The runner then records `noop
  already_up_to_date` (runner:824-825, 861-863). `restoreAsWorktree` recreates the branch with `git
  branch <name> <sha>` (no tracking) and registers it with `worktree add --no-checkout`, so a
  restored worktree has no upstream; the same is true for MCP `create_worktree` with `push: false`
  (`branch --no-track`) and for the `(without tracking)` fallback in addWorktree. Failure scenario:
  User restores a trashed worktree (`sync-worktrees trash --restore <id>`), a teammate pushes to
  that branch, hourly sync runs: canFastForward → true, isWorktreeBehind → `fatal: no upstream
  configured` → false → outcome `already_up_to_date`; the worktree silently stays at the old commit
  on every tick, with the log saying it is up to date. Verified in the scratch repo: after `git
  branch b2 <old>` + `worktree add --no-checkout` and a remote push, `rev-parse --abbrev-ref
  b2@{upstream}` fails while `merge-base == HEAD` and `rev-list --count HEAD..origin/b2` = 1.
- **Expected behavior**: Behind/ahead classification must use the same explicit `origin/<branch>`
  ref as canFastForward (e.g. a single `git rev-list --left-right --count HEAD...origin/<branch>`
  taking the branch name from the runner), so upstream configuration is irrelevant to sync.
  Independently, `restoreAsWorktree` and the MCP create path should set `branch.<name>.remote/merge`
  (`git branch --set-upstream-to origin/<name>`) when the remote branch exists, so `git pull`/status
  in the worktree behave normally too. isWorktreeBehind must not treat a probe error as 'not behind'
  — throw so the runner records `update_check_failed`.
- **Acceptance**: E2E: init, push a branch, sync, let prune trash the worktree (delete remote
  branch), re-push the branch, `trash --restore`, push a new commit, sync → the restored worktree's
  HEAD equals origin/<branch> and the outcome contains `updated fast_forward` for it. Unit: runner
  test where `isWorktreeBehind`/the new classifier is given a worktree with no upstream but a
  differing origin tip → recorded `updated`, not `already_up_to_date`. Replace
  git-update.test.ts:86-97 (which enshrines 'no upstream → false') with a test that the branch
  argument is used.
- **Notes**: Guards checked: Restore reapplies sparse config and resets the index but never
  configures tracking; nothing in the update phase checks for a missing upstream; the catch-all in
  isWorktreeBehind hides the error; the only test for this case asserts the wrong behaviour as
  intended. F3 fixed MCP staleness (fetch before update) but not the missing-upstream
  classification.

### [ ] T4. LFS-skip retry is wired only to fetchAll, where LFS never fails; per-worktree checkout LFS failures are swallowed by Promise.allSettled and repeat every tick

- **Category**: correctness · **Subsystem**: worktree-sync
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/worktree-mode-sync-runner.ts:252-265` (`fetchLatestRemoteData (only
  LFS fallback site)`), `src/services/worktree-mode-sync-runner.ts:384-402` (`createNewWorktrees —
  allSettled swallows the rethrow`), `src/services/worktree-sync.service.ts:506-514` (`retry(() =>
  runner.runSyncAttempt(...)) — never sees per-branch errors`),
  `src/services/sync-retry-policy.ts:45-51` (`lfsRetryHandler`),
  `src/services/git.service.ts:558-607, 758-809` (`addWorktree / runWorktreeAddByMatrix (where
  smudge runs)`), `src/services/__tests__/worktree-sync.service.test.ts:1341-1394` (`LFS tests cover
  only the fetchAll path`), `README.md:610` (`'The tool also retries LFS-specific failures with LFS
  disabled'`)
- **Current behavior**: `git fetch` into the bare repo never invokes the LFS smudge filter
  (verified), so the `isLfsError` branch in fetchLatestRemoteData and the retry policy's
  `lfsRetryHandler` are effectively unreachable. The place LFS actually fails is `git worktree add`
  (checkout → smudge). That error is caught in createNewWorktrees, recorded as `create_failed`,
  rethrown into `Promise.allSettled` and dropped; runSyncAttempt resolves, so `retry()`'s
  shouldRetry/lfsRetryHandler never run and `setLfsSkipEnabled(true)` is never called. Additionally
  git creates the local branch before checkout and leaves it behind on failure
  (runWorktreeAddByMatrix throws before returning `createdNewBranch`, so no rollback). Failure
  scenario: Repo with one LFS object missing on the server (or an LFS endpoint that needs auth the
  daemon lacks). Every sync: `worktree add` fails with `fatal: <file>: smudge filter lfs failed`,
  the branch is recorded failed, `Created 0/1 worktrees`, runOnce exits 1 (index.ts:157-176), and
  the next tick repeats the full checkout and fails identically — forever. The documented fallback
  (README:610, `retry.maxLfsRetries`) never engages although `GIT_LFS_SKIP_SMUDGE=1` would succeed
  (verified with a filter that honours the variable).
- **Expected behavior**: In createNewWorktrees (and the diverged recreate path), when
  `isLfsError(getErrorMessage(error))` and `!config.skipLfs && !syncContext.lfsSkipEnabled`: enable
  the skip (`gitService.setLfsSkipEnabled(true)`, `syncContext.lfsSkipEnabled = true`, log the same
  '⚠️ Temporarily disabling LFS downloads' line), record an `lfs_skip_enabled` skip/noop action, and
  retry that branch's addWorktree once with skip enabled (remaining branches then create with skip).
  Alternatively rethrow an LFS-tagged error out of runSyncAttempt so the existing retry policy
  engages (maxLfsRetries then applies). Either way `resetLfsSkipIfNeeded` restores the flag after
  the sync. Also roll back the git-created local branch when `worktree add` itself fails in the
  remote-only matrix case.
- **Acceptance**: Runner unit test: addWorktree rejects once with 'smudge filter lfs failed' then
  resolves → `setLfsSkipEnabled(true)` called, addWorktree called twice for that branch, outcome
  counts created=1, failed=0, one action with reason `lfs_skip_enabled`; second consecutive LFS
  failure → recordFailed. E2E (reproducible without git-lfs): bare repo with
  `filter.lfs.required=true` and `filter.lfs.smudge='sh -c "[ \"$GIT_LFS_SKIP_SMUDGE\" = 1 ] && cat
  || { echo Object does not exist on the server >&2; exit 1; }"'` plus `.gitattributes` `*.bin
  filter=lfs` → sync creates the worktree with pointer content and exits 0. Test that no stray local
  branch remains after a failed `worktree add`.
- **Notes**: Re-verified: `createNewWorktrees` (runner 384-402) records `create_failed` and swallows
  the rejection via `Promise.allSettled`, so `runSyncAttempt` resolves and the retry policy's
  `lfsRetryHandler` (sync-retry-policy.ts:45-51) never fires; only `fetchAll` (runner 252-265) has
  an LFS fallback. Also reported as: “LFS-skip retry only wraps the fetch; checkout-time LFS
  failures in create/update are swallowed by allSettled and never retried with LFS disabled (README
  promises otherwise)”.

### [ ] T5. With skipLfs:true every status probe runs git with an env of only {GIT_LFS_SKIP_SMUDGE:1} — global gitignore/config ignored, PATH lookup broken (5.3.1 env fix missed this site)

- **Category**: correctness · **Subsystem**: worktree-sync
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/worktree-status.service.ts:613-623`
  (`WorktreeStatusService.createGitInstance`), `src/services/git.service.ts:80-91, 93-105`
  (`getCachedGit / buildSimpleGitOptions (the fixed pattern)`), `src/utils/git-env.ts:1-15`
  (`sanitizeGitEnv comment: .env() replaces the child environment wholesale`),
  `src/services/worktree-mode-sync-runner.ts:471, 526, 811` (`callers: prune status, recheck, update
  gate`), `CHANGELOG.md:5.3.1` (`'forward the full (sanitized) process environment to every
  clone-mode and LFS-skip git subprocess'`)
- **Current behavior**: `createGitInstance` builds `simpleGit(worktreePath).env({
  GIT_LFS_SKIP_SMUDGE: '1' })` when `config.skipLfs` is set. simple-git passes that object verbatim
  as the child `env` (dist index.js:1364-1370), so `git status`, `check-ignore`, `branch`, `stash
  list`, `submodule status`, `rev-list` used by checkWorktreeStatus/getFullWorktreeStatus run
  without HOME, XDG_CONFIG_HOME, PATH, USER. git.service.ts:86/124/400 were changed in 5.3.1 to
  spread `sanitizeGitEnv(process.env)`; this site was not. Failure scenario: (a) User has
  `~/.config/git/ignore` or `core.excludesFile` ignoring `.DS_Store`/`.idea/`/`*.log` and sets
  `skipLfs: true`. Every worktree containing such a file reports `?? .DS_Store` →
  checkWorktreeStatus false → `dirty_worktree` skip; getFullWorktreeStatus → 'uncommitted changes' →
  never pruned. Verified: with the inherited env the status list is empty; with the replaced env it
  is `?? untracked.log`. (b) git installed outside libc's default search path (nix, /usr/local/bin,
  Homebrew without /usr/bin shim): spawn fails ENOENT (verified: binary found only via PATH → ENOENT
  when env lacks PATH), every probe fails closed → all worktrees permanently 'uncommitted
  changes'/`update_check_failed`. (c) `safe.directory` from ~/.gitconfig not read → 'dubious
  ownership' on shared/CI checkouts.
- **Expected behavior**: createGitInstance uses `{ ...sanitizeGitEnv(process.env),
  GIT_LFS_SKIP_SMUDGE: '1' }` and the same `unsafe: { allowUnsafeAskPass, allowUnsafeConfigEnvCount
  }` options as buildSimpleGitOptions (ideally WorktreeStatusService receives GitService's
  getCachedGit as its git factory so there is one client cache and one env policy).
- **Acceptance**: Unit test in worktree-status.service.test.ts: with `skipLfs: true`, the simple-git
  mock's `.env()` argument contains `PATH` and `HOME` from process.env plus `GIT_LFS_SKIP_SMUDGE:
  '1'`, and not `EDITOR`. E2E: skipLfs:true, HOME pointing at a dir with `.config/git/ignore` =
  `*.log`, untracked `x.log` in a worktree → sync records the worktree as clean/updated and prune
  can remove it.
- **Notes**: Re-verified: `worktree-status.service.ts:618` passes a bare `{ GIT_LFS_SKIP_SMUDGE: '1'
  }` object to simple-git's `.env()`, which replaces the child environment; `git.service.ts:86` and
  `clone-sync.service.ts:185` already spread `sanitizeGitEnv(process.env)` — mirror that.

### [ ] T6. A transient probe failure in canFastForward/isLocalAheadOfRemote is interpreted as 'diverged' and can move a healthy, fully pushed worktree to trash and recreate it

- **Category**: guardrail · **Subsystem**: worktree-sync
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/git.service.ts:1215-1250` (`canFastForward / isLocalAheadOfRemote
  catch → false`), `src/services/worktree-mode-sync-runner.ts:814-822` (`Phase 4a: !canFastForward
  && !isAhead → 'diverged'`), `src/services/worktree-mode-sync-runner.ts:965-1055`
  (`handleDivergedBranch → divergeWorktree`), `src/services/worktree-status.service.ts:143-157`
  (`the codebase's own fail-closed rule for unverifiable probes`)
- **Current behavior**: simple-git resolves a genuine 'no common ancestor' (merge-base exit 1) to an
  empty string, so the `catch` blocks in canFastForward/isLocalAheadOfRemote are reached only by
  real failures (spawn error, `fatal: …`, ENOMEM/EMFILE). Both return false on such failures; the
  runner treats (false,false) as diverged and schedules handleDivergedBranch, which after the stash
  check compares trees and metadata and — when HEAD != metadata.lastSyncCommit — moves the directory
  to trash and re-adds the branch from origin. Failure scenario: User committed and pushed in a
  worktree (HEAD == origin/X, metadata.lastSyncCommit older). During a tick with many concurrent
  probes (prune phase runs up to 20 status checks × 6 parallel git processes, see the
  concurrency-cap finding) `merge-base` fails to spawn (EMFILE) for that worktree and the follow-up
  `merge-base` in isLocalAheadOfRemote fails too; compareTreeContent fails → false;
  hasLocalChangesSinceLastSync → true → divergeWorktree: the user's directory (node_modules,
  untracked build output) disappears into .trash, the branch ref is deleted and a fresh checkout
  replaces it. Reversible via trash restore, but destructive from the user's point of view and
  caused purely by a probe error, contradicting the fail-closed rule applied elsewhere.
- **Expected behavior**: Probe predicates must distinguish 'no' from 'cannot determine': let
  canFastForward/isLocalAheadOfRemote (or the single replacement classifier) throw on real errors so
  Phase 4a's allSettled path records `update_check_failed` and never enqueues diverged handling;
  keep the empty merge-base result as the 'diverged' signal. handleDivergedBranch should
  additionally re-verify divergence with a throwing probe (HEAD != origin/X and HEAD not an
  ancestor) before any move, and abort on failure.
- **Acceptance**: Runner test: canFastForward rejects with an Error → outcome contains `skipped
  update_check_failed` for that branch, `handleDivergedBranch`/trash/removeWorktree never called.
  Test: merge-base returning '' (unrelated histories) still leads to diverged handling. Test in
  handleDivergedBranch: probe throwing after the stash check → recordFailed
  `diverged_recovery_failed`, no divergeWorktree call.
- **Notes**: Re-verified: `canFastForward`/`isLocalAheadOfRemote` (git.service.ts:1215-1250) both
  return false on any thrown error; the runner (814-821) maps false/false to `diverged`. With no
  metadata (`hasLocalChangesSinceLastSync` → true) `handleDivergedBranch` trashes and recreates the
  worktree.

### [ ] T7. Trash moves run `du` over the whole worktree (node_modules included) under the repo lock before the 8 ms rename; size is informational only

- **Category**: performance · **Subsystem**: worktree-sync
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/trash.service.ts:145` (`TrashService.trashDirectory —
  calculateDirectorySize before rename`), `src/services/trash.service.ts:213-235, 241-243` (`HEAD
  re-verify comment acknowledging the slow scan; rename`), `src/utils/disk-space.ts:9-23`
  (`calculateDirectorySize → fast-folder-size (exec du)`),
  `src/services/worktree-mode-sync-runner.ts:517-585, 1080-1088` (`prune removal
  (maxWorktreeRemoval=3) and diverged replace call sites`)
- **Current behavior**: Every prune/diverged/orphan trash move first execs `du -sb <worktree>`
  (fast-folder-size) to fill `manifest.sizeBytes`, then re-verifies HEAD, writes the manifest and
  renames the directory. The scan happens inside runExclusiveRepoOperation (lock held, TUI/MCP
  operations queued) and inside the removal concurrency slot, and its only consumers are the
  `warnSizeBytes` warning and TUI/preview totals. Failure scenario: branchMaxAge lowered from 6m to
  30d → 40 stale worktrees each with a 1–3 GB node_modules become prune candidates in one tick.
  Measured: `du -sb` on an 80k-file tree took 533 ms cold / 133 ms warm while `mv` took 8 ms; real
  node_modules trees (300k–1M files, cold page cache, or on network/APFS volumes) take 10–60 s each,
  so the prune phase holds the repo lock for many minutes doing nothing but size accounting, and the
  HEAD-moved race window the code comments on is widened by exactly that time.
- **Expected behavior**: Compute the size after the rename (the payload is already inside .trash, so
  `du` on payloadPath cannot delay or endanger the removal) and write it into the manifest
  best-effort (`sizeBytes: null` until known), or defer sizing to the reaper/TUI listing which
  already tolerates `sizeBytes === null` (summarizeTrashEntries, getForceCleanPreview).
- **Acceptance**: trash.service.test.ts: assert `fs.rename` is called before
  `calculateDirectorySize`, that a rejected size calculation still yields a valid manifest with
  `sizeBytes: null`, and that the HEAD re-verify happens without an intervening size scan. Manual:
  prune of a worktree with a large node_modules holds the lock for milliseconds, not the `du`
  duration.
- **Notes**: Re-verified: `calculateDirectorySize` runs at trash.service.ts:145 before the container
  is created, inside the removal pipeline that holds the repo lock; the size only feeds
  `manifest.sizeBytes` and the TUI preview.

### [ ] T8. LFS verification sleeps up to 30 s per created worktree, serialized, although nothing can change the files after `worktree add` returns (F18 left the wait in place)

- **Category**: performance · **Subsystem**: worktree-sync
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/git.service.ts:398-495` (`verifyLfsFilesDownloaded (poll loop
  446-486)`), `src/services/git.service.ts:605-607, 662-664, 727-729` (`addWorktree call sites (runs
  for every creation)`), `src/constants.ts:61` (`LFS_VERIFICATION_MAX_RETRIES: 30 (not
  user-configurable)`), `src/services/worktree-mode-sync-runner.ts:380-382` (`maxWorktreeCreation
  default 1 (serial)`)
- **Current behavior**: After each `git worktree add`, when git-lfs is installed and `git lfs
  ls-files` lists files, 5 samples are read; if any still holds the LFS pointer header the code
  sleeps 1 s and re-reads, up to 30 times, then warns. `git checkout` (including git-lfs delayed
  checkout and the post-checkout hook) completes synchronously before `worktree add` returns, so the
  sampled files cannot change during the wait; the first read is authoritative. F18 fixed sampling
  and extracted the constant but the wall remains and is not exposed in Config. Failure scenario:
  Developer has `GIT_LFS_SKIP_SMUDGE=1` exported in their shell/CI (common for large LFS repos) but
  not `skipLfs: true` in the config: the non-skip simple-git client inherits the variable, checkouts
  leave pointers, and every created worktree costs 30 s of sleep with `maxWorktreeCreation=1`: first
  sync of 100 branches waits ~50 minutes (plus 100 warnings). The same happens with
  `lfs.fetchexclude` patterns or any LFS server outage that git-lfs downgrades to pointers.
  Additionally `git lfs ls-files` walks the entire index for every creation even in repos with no
  LFS content.
- **Expected behavior**: Check once (no polling); on pointer detection log one warning naming the
  worktree and suggesting `skipLfs: true` / checking `GIT_LFS_SKIP_SMUDGE`. Treat
  `process.env.GIT_LFS_SKIP_SMUDGE === '1'` as skipLfs for verification purposes. Skip `git lfs
  ls-files` when HEAD's `.gitattributes` has no `filter=lfs` entry (one `git check-attr`/grep per
  sync, cached by tree oid).
- **Acceptance**: Unit test: files with the pointer header produce exactly one warning and the
  promise resolves without any setTimeout (use fake timers and assert no pending timers). Test: with
  `GIT_LFS_SKIP_SMUDGE=1` in process.env, verification is skipped. Test: repo without lfs attributes
  → `lfs ls-files` not invoked. Manual: creating 20 worktrees with pointers present takes seconds,
  not 10 minutes.
- **Notes**: Re-verified: `verifyLfsFilesDownloaded` (git.service.ts:446-486) polls up to
  `LFS_VERIFICATION_MAX_RETRIES` (30) times with a 1 s sleep after `worktree add` has already
  returned, and warns with `Could not verify LFS files` on every creation when `git lfs` is not
  installed (492-494), regardless of whether the repository uses LFS. Fold the no-git-lfs warning
  (probe once per process, skip when `.gitattributes` declares no lfs filter) into the same rework.
  Also reported as: “Clone-mode init blocks up to 30 s in the LFS verification poll after a
  synchronous `git clone`, where nothing can change the sampled files (F18 follow-up)”; “LFS
  verification warns for every created worktree on machines without git-lfs, even for repositories
  that do not use LFS”.

### [ ] T9. Long-lived process never recovers when the default-branch worktree is deleted out-of-band: every later sync fails with 'spawn git ENOENT'

- **Category**: correctness · **Subsystem**: worktree-sync
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/worktree-sync.service.ts:491-493` (`WorktreeSyncService.sync`),
  `src/services/git.service.ts:259-261` (`GitService.isInitialized`),
  `src/services/git.service.ts:155-187` (`GitService.initialize (stale main-worktree heal)`),
  `src/services/git.service.ts:325-336` (`GitService.fetchAll / fetchBranch (cwd =
  mainWorktreePath)`), `src/services/git.service.ts:252-257, 344-346, 1058` (`GitService.getGit /
  getRemoteBranches / getRemoteBranchTips`), `src/services/worktree-mode-sync-runner.ts:51-58`
  (`WorktreeModeSyncRunner.runSyncAttempt`)
- **Current behavior**: The 5.3.1 'recreate the default-branch worktree when its directory was
  deleted out-of-band' heal lives only in GitService.initialize() (git.service.ts:155-187). sync()
  calls initializeUnlocked() only when !isInitialized() (worktree-sync.service.ts:491), and
  isInitialized() is simply `this.git !== null`, which becomes true after the first initialize and
  never resets. Every remote-facing operation in the sync (fetchAll, fetchBranch, getRemoteBranches,
  getRemoteBranchesWithActivity, getRemoteBranchTips) runs a simple-git instance whose cwd is the
  default-branch worktree directory, not the bare repo. Once that directory is gone, spawn fails
  with ENOENT and the sync throws before any planning happens; nothing ever re-runs the heal.
  Failure scenario: Daemon/TUI/MCP process is running (worktree mode). User runs `rm -rf
  worktrees/main` to 'reset' it (or the volume is unmounted). Next cron tick: runSyncAttempt ->
  fetchLatestRemoteData -> gitService.fetchAll() -> simple-git spawns `git` with
  cwd=<worktreeDir>/main -> `Error: spawn git ENOENT` (which reads as 'git is not installed'). Every
  subsequent tick fails identically until the process is restarted; no worktree is ever recreated,
  no branches are created/pruned/updated for that repo. Verified in-process with the repo's own
  WorktreeSyncService: sync #1 ok, `fs.rm(main)`, sync #2 and #3 both reject with `spawn git
  ENOENT`, main dir still absent.
- **Expected behavior**: A sync must not depend on the default-branch worktree directory existing.
  Either (a) run every bare-repo-level read and the fetch against the bare repo (cwd = bareRepoPath)
  so fetch/plan/prune/update proceed and the missing main worktree is rebuilt by the normal create
  pipeline, or (b) re-run the missing-main-worktree heal (probePathExists(mainWorktreePath) ===
  'missing' -> clear registration -> recreate) at the start of every runSyncAttempt, not only inside
  initialize(). At minimum the error must name the missing directory rather than surfacing as 'spawn
  git ENOENT'.
- **Acceptance**: In-process test (no NODE_ENV gating needed): create remote with main+feat,
  WorktreeSyncService.sync() once, `fs.rm(<worktreeDir>/main, {recursive:true})`, sync() again in
  the same service instance -> resolves with started:true, <worktreeDir>/main exists again and is
  registered (`git worktree list --porcelain` contains it), feat worktree still intact, no action
  with reason 'sync_failed'. Also assert the log line mentions the missing main worktree path when
  the heal runs.
- **Notes**: Re-verified: `WorktreeSyncService.sync` only initializes when `isInitialized()` is
  false (worktree-sync.service.ts:491-493), and `fetchAll` runs through the client cached for
  `mainWorktreePath` (git.service.ts:328), so once the default-branch directory disappears every
  later tick fails at spawn.

### [ ] T10. Lock-directory preparation failure is misreported as 'another process holds the lock', counted as a skip, and runOnce exits 0 having synced nothing

- **Category**: workflow · **Subsystem**: worktree-sync
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/repo-operation-lock.ts:177-190`
  (`RepoOperationLock.acquireWorktreeDirLock (silent catch -> null)`),
  `src/services/repo-operation-lock.ts:192-217` (`RepoOperationLock.acquireWorktreeModeLock`),
  `src/services/worktree-sync.service.ts:440-445` (`runExclusiveRepoOperation (null -> reason
  'locked')`), `src/index.ts:119-123, 157-176` (`runMultipleRepositories exit-code derivation`)
- **Current behavior**: acquireWorktreeDirLock swallows any mkdir/writeFile error on the lock target
  (ENOTDIR/EACCES/EROFS/ENOSPC) and returns null without logging the cause.
  runExclusiveRepoOperation maps null to `{started:false, reason:'locked'}` and logs 'Another
  process holds the sync lock for this repo, skipping...'. index.ts adds every !started repo to
  skippedNames, which does not contribute to failedCount, so process.exitCode stays 0. Failure
  scenario: CI container or hardened host where XDG_STATE_HOME / ~/.cache is not creatable (non-root
  uid without a home, read-only state volume, XDG_STATE_HOME pointing at a file). `sync-worktrees
  --runOnce` prints 'Another process holds the sync lock' for every repo, then 'Processed N repos: 0
  synced, N skipped, 0 failed' and exits 0. No clone, no worktrees, no fetch happened; the pipeline
  goes green. Verified with XDG_STATE_HOME=/dev/null/x: exit code 0, no worktreeDir created, message
  blames a non-existent other process.
- **Expected behavior**: Distinguish infrastructure failure from contention: acquire() returns a
  typed reason (`locked` only for ELOCKED; `lock_unavailable` with errno and path for prep/lock
  errors) and logs the underlying error. runExclusiveRepoOperation surfaces `lock_unavailable`;
  index.ts counts it as a failure (exit code 1) rather than a skip, and the summary line names it.
  Daemon/TUI log it as an error, not a skip.
- **Acceptance**: Unit: RepoOperationLock with XDG_STATE_HOME pointing at a regular file ->
  acquire() result carries reason 'lock_unavailable' and a warn log containing the path and errno;
  with a real ELOCKED -> 'locked'. CLI test (like index.run-once.test.ts): unwritable state dir ->
  exit code 1 and summary shows '1 failed', message does not say another process holds the lock.
  Existing contention behaviour (exit 0, 'skipped') unchanged.
- **Notes**: Re-verified: `acquireWorktreeDirLock` returns null on mkdir/writeFile failure
  (repo-operation-lock.ts:41-53); `runExclusiveRepoOperation` logs 'Another process holds the sync
  lock' and returns `{started:false, reason:'locked'}` (worktree-sync.service.ts:441-445);
  `runMultipleRepositories` counts that as skipped and exits 0 (index.ts:121-123, 157-176).

### [ ] T11. fs.cp in the cross-device diverged path (and trash restore) rewrites relative symlinks to absolute source paths that are then deleted, leaving dangling links in the preserved/restored copy

- **Category**: correctness · **Subsystem**: worktree-sync
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/worktree-mode-sync-runner.ts:1119-1126` (`divergeWorktree EXDEV
  fallback (fs.cp + fs.rm)`), `src/services/trash.service.ts:545-551` (`TrashService.copyPayloadOver
  (fs.cp)`), `src/services/trash.service.ts:428-434` (`TrashService.restore (rm of container after
  copy)`)
- **Current behavior**: Both call fs.cp(src, dst, {recursive:true}) without verbatimSymlinks. Node
  resolves every relative symlink target against the source directory and creates the destination
  link as an absolute path into the source tree. divergeWorktree then `fs.rm(worktreePath)` and
  restore then `fs.rm(containerPath)`, so every relative symlink in the copy points into a tree that
  no longer exists. Failure scenario: (a) Trash disabled, a worktree lives on a different filesystem
  than <worktreeDir>/.diverged (bind-mounted or symlinked to a bigger disk); upstream force-pushes;
  the worktree has local commits. rename -> EXDEV -> fs.cp -> rm. The preserved .diverged copy's
  node_modules/.bin/* shims, pnpm's node_modules/.pnpm links, and any relative symlinks committed to
  the repo now dangle (ENOENT). (b) More common: `sync-worktrees trash --restore <id>` of a
  pnpm/yarn project: copyPayloadOver rewrites relative links to absolute paths under
  .trash/<id>/payload, then the container is removed; the restored worktree's dependency links are
  broken and `git status` may show committed symlinks as modified.
- **Expected behavior**: Copies used for preservation/restore must be byte-faithful for symlinks:
  pass `verbatimSymlinks: true` to fs.cp (keep dereference:false), so relative link targets are
  copied verbatim. Optionally verify a sample of symlinks after copy before deleting the source.
- **Acceptance**: Unit test: tree with `a/link -> ../b/file` copied via the helper, then source
  removed; `fs.readlink(copy/a/link)` === '../b/file' and `fs.readFile(copy/a/link)` succeeds. Apply
  to divergeWorktree EXDEV branch and copyPayloadOver; existing 'copy+remove fallback when rename
  fails with EXDEV' test extended with a relative symlink.
- **Notes**: Node's `fs.cp` resolves a relative symlink target against the source directory unless
  `verbatimSymlinks: true` is passed, so the copied link becomes absolute and points into the
  directory that is deleted next.

### [ ] T12. Adopting a directory whose `.git` is a gitdir pointer (linked worktree / submodule) rewrites the PARENT repository's fetch refspec and deletes its remote-tracking refs

- **Category**: guardrail · **Subsystem**: clone-sync
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/clone-sync.service.ts:576-603`
  (`CloneSyncService.initializeInternal`), `src/services/clone-sync.service.ts:213-217`
  (`CloneSyncService.configureSingleBranchRemote`), `src/services/clone-sync.service.ts:402-427`
  (`CloneSyncService.deleteStaleRemoteTrackingRefs`), `src/services/clone-sync.service.ts:487, 547`
  (`CloneSyncService.checkoutBranch`)
- **Current behavior**: `initializeInternal` decides "existing clone" purely from
  `fs.readdir(worktreeDir).includes(".git")` (line 593). A `.git` *file* (`gitdir: ...`) from `git
  worktree add` or a submodule passes that check. `validateExistingClone` only compares `remote
  get-url origin` and `rev-parse --abbrev-ref HEAD`, both of which read the shared config/HEAD and
  succeed. The code then runs `git config --replace-all remote.origin.fetch <single refspec>`,
  `config --replace-all remote.origin.tagOpt`, and `update-ref -d` on every `refs/remotes/origin/*`
  except the tracked one (lines 603, 213-217, 410-427) — and repeats this on every sync tick (line
  909) and in `checkoutBranch` (487/547). In a linked worktree these operations act on the common
  git dir of the parent repository. Failure scenario: User has a repo checked out at `/w/app` (main
  checkout) plus `git worktree add /w/app-main main` (or a worktree-mode-managed worktree). They add
  a clone-mode entry `{ mode: "clone", worktreeDir: "/w/app-main", branch: "main" }` to get a
  fixed-path sibling. First sync: `/w/app`'s `remote.origin.fetch` becomes
  `+refs/heads/main:refs/remotes/origin/main` and every other `refs/remotes/origin/*` in `/w/app` is
  deleted. If `/w/app` is a worktree-mode bare repo, its next `fetch --all --prune` now prunes every
  remaining origin ref and the worktree-mode runner treats all other branches as gone and moves
  their worktrees to trash. Verified with git 2.43 (scratch exp2): after `git -C linked config
  --replace-all ...` and `git -C linked update-ref -d refs/remotes/origin/feature`, the primary
  repo's refspec was narrowed and `refs/remotes/origin/feature` was gone; `rev-parse
  --git-common-dir` in the linked dir pointed at `primary/.git`.
- **Expected behavior**: Before any mutation of an adopted directory (existing-clone init path and
  `checkoutBranch`), verify it is a primary, non-linked checkout:
  `lstat(worktreeDir/.git).isDirectory()` and `path.resolve(git rev-parse --git-common-dir)` ===
  `path.resolve(worktreeDir, ".git")` (also `!= --git-dir` mismatch). If not, throw
  `ConfigError("CLONE_DESTINATION_NOT_PRIMARY_CHECKOUT")` naming the resolved common dir, without
  running `config --replace-all` or `update-ref -d`. `getWorktrees()`/listing may still report the
  directory.
- **Acceptance**: Unit test: `fs.readdir` → [".git"], `rev-parse --git-common-dir` mocked to
  `/other/repo/.git` → `initialize()` rejects with the new code and `gitMock.raw` is never called
  with `["config","--replace-all",...]` or `["update-ref","-d",...]`. E2E test (reuse
  `createLocalRemote` helpers in src/__tests__/e2e/clone-mode.e2e.test.ts): clone a primary repo
  with two remote branches, `git worktree add` a linked dir, point a clone-mode config at the linked
  dir, run the CLI → non-zero exit, and the primary's `git config --get-all remote.origin.fetch` and
  `for-each-ref refs/remotes/origin` are unchanged.
- **Notes**: Re-verified: `entries.includes('.git')` (clone-sync.service.ts:593) matches a `.git`
  FILE (linked worktree or submodule gitdir pointer) as well as a directory; every later git command
  then resolves to the parent repository.

### [ ] T13. A clone that fails after fetch ("Clone succeeded, but checkout failed", e.g. LFS smudge error) is left in place and silently adopted as a valid clone on the next run; sync then reports `dirty_tree` forever

- **Category**: correctness · **Subsystem**: clone-sync
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/clone-sync.service.ts:641-651` (`CloneSyncService.initializeInternal
  (clone catch)`), `src/services/clone-sync.service.ts:763-795`
  (`CloneSyncService.maybeCleanupPartialClone`), `src/services/clone-sync.service.ts:593-623`
  (`CloneSyncService.initializeInternal (existing-clone adoption)`),
  `src/services/clone-sync.service.ts:940-949` (`CloneSyncService.runSyncAttemptInternal
  (dirty_tree)`)
- **Current behavior**: When `git clone` exits non-zero after the objects were fetched (git prints
  "Clone succeeded, but checkout failed"; exit 128), the directory contains a complete `.git` with
  `HEAD` and a partially written tree. `maybeCleanupPartialClone` sees `hasUsableGit === true` and
  deliberately leaves it (lines 779-794); no pending marker is written because that happens only
  after `clone()` resolves (line 664). The failure is recorded and thrown (first run exits 1). On
  the next run/tick `initializeInternal` finds `.git`, `validateExistingClone` passes (origin
  matches, HEAD is `main`), no pending marker → the clone is adopted as a pre-existing user clone:
  no checkout retry, no sparse setup, no LFS verify, no `filesToCopyOnBranchCreate`. Every
  subsequent `runSyncAttempt` sees staged deletions + untracked files and records `dirty_tree` at
  info level. Failure scenario: LFS-backed repo; one LFS object missing on the server (the exact
  condition `isLfsError` matches: "smudge filter lfs failed" / "Object does not exist on the
  server"). Run 1: clone fails, tool logs "Clone failed; leaving ... for manual inspection", exit 1.
  Run 2 (daemon tick or next `runOnce`): `Existing clone validated`, then `⏭️ Skipping ff-merge ...
  working tree has local changes`, summary "1 with clone-mode skips, 0 failed", exit 0 — for a
  directory the user never touched, with no copied config files. Reproduced with git 2.43 using a
  required failing smudge filter (scratch exp1): clone exit 128, `.git/HEAD` present, `git rev-parse
  --abbrev-ref HEAD` → `main`, `git status --short` → `D .gitattributes`, `D README`, `D a.bin`, `??
  .gitattributes`, `?? README`.
- **Expected behavior**: A clone the tool started must never be adopted as a user clone. When
  `clone()` rejects and the tool created the directory (`cloneCreatedDir`), either (a) remove the
  directory (it contains no user data), or (b) write `.git/.sync-worktrees-clone-incomplete` and
  make the existing-clone path refuse adoption with a hard `GitOperationError("clone-init",
  "previous clone of '<dir>' did not complete (<original error>); remove the directory or fix the
  cause")` — optionally retrying `git checkout -f HEAD` under `GIT_LFS_SKIP_SMUDGE=1` when the
  original error was an LFS error, then continuing the normal post-clone steps (pending marker,
  sparse, LFS verify, file copy). Either way the second run must fail loudly (exit 1), not report a
  clone-mode skip.
- **Acceptance**: Unit test: `fs.readdir` → ENOENT, `clone` rejects with "smudge filter lfs failed",
  `fs.access(.git/HEAD)` resolves → marker written (or `fs.rm` called on the dir); a fresh
  `initialize()` with `readdir` → [".git", ...] and the marker present rejects and never records
  `dirty_tree`/`branch_mismatch`. E2E (local remote + `git -c filter.x.smudge=false -c
  filter.x.required=true` via `GIT_CONFIG_*` env or a `.gitattributes` filter): first CLI run exit
  1; second run exit 1 with the incomplete-clone error and no "clone-mode skips" line.
- **Notes**: Re-verified: `maybeCleanupPartialClone` keeps the directory whenever `.git/HEAD` exists
  (763-795), and the next init adopts it through `validateExistingClone`, which only checks origin
  URL and current branch.

### [ ] T14. LFS smudge failure during clone-mode ff-merge: retry policy's LFS-skip override is never honored by clone-mode git clients, and the failed merge leaves stray files that turn every later tick into a permanent `dirty_tree` skip

- **Category**: correctness · **Subsystem**: clone-sync
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/clone-sync.service.ts:184-190` (`CloneSyncService.buildGitEnv`),
  `src/services/clone-sync.service.ts:1011-1016` (`CloneSyncService.runSyncAttemptInternal (merge
  --ff-only)`), `src/services/sync-retry-policy.ts:45-51`
  (`SyncRetryPolicy.createOptions.lfsRetryHandler`), `src/services/git.service.ts:1137-1143`
  (`GitService.setLfsSkipEnabled / isLfsSkipEnabled`), `src/utils/retry.ts:119-121` (`retry
  (lfsRetryHandler call)`)
- **Current behavior**: `WorktreeSyncService.sync()` wraps `cloneSync.runSyncAttempt` in `retry()`
  with `SyncRetryPolicy` options. On an LFS error the policy calls
  `gitService.setLfsSkipEnabled(true)` and logs "Will retry with LFS skipped".
  `CloneSyncService.buildGitEnv` only consults `this.config.skipLfs` (line 186) and
  `GitService.isLfsSkipEnabled` is private, so the retry attempt runs `git merge origin/<b>
  --ff-only` with the identical environment. Worse, git's failed checkout has already written the
  files that sort before the failing LFS file (index/HEAD untouched), so the retry's
  `checkWorktreeStatus` sees untracked/modified files and records `dirty_tree` (info level) — the
  sync then "succeeds" and every following tick repeats `dirty_tree`; even fixing LFS does not help
  because git refuses to overwrite the now-untracked files. Failure scenario: Clone-mode repo
  tracking `main`; upstream commit adds `.gitattributes` + `assets/big.bin` (LFS) while the LFS
  server is unreachable. Tick N: merge fails with "smudge filter lfs failed"; retry logs
  "Temporarily disabling LFS downloads", but merge attempt 2 (or the dirty check) fails/skips
  identically. Tick N+1..∞: `⏭️ Skipping ff-merge — working tree has local changes`, exit 0, and the
  clone never advances until a human runs `git clean`. Reproduced with git 2.43 and a required
  failing filter (scratch exp4): first merge exit 128 with HEAD unchanged and `?? .gitattributes`
  left behind; second merge (same env) and third merge (filter fixed) both abort with `exit 1`
  because the untracked file would be overwritten.
- **Expected behavior**: (a) `CloneSyncService` must honor the sync-level LFS override: expose
  `GitService.isLfsSkipEnabled()` (or inject a getter) and OR it into `buildGitEnv`, so the LFS
  retry's merge/fetch/clone run with `GIT_LFS_SKIP_SMUDGE=1`. (b) When `merge --ff-only` rejects and
  HEAD did not move, restore the pre-merge state before returning: for paths in `git diff
  --name-only HEAD refs/remotes/origin/<b>`, delete untracked files whose `git hash-object` equals
  the blob in `origin/<b>` and `git checkout HEAD -- <path>` for tracked paths that are now
  modified; log what was cleaned. The tree was verified clean immediately before the merge, so this
  cannot touch user work.
- **Acceptance**: Unit test: `merge` rejects once with "smudge filter lfs failed"; after
  `gitService.setLfsSkipEnabled(true)` the next `simpleGit(...).env()` call for the merge receives
  `GIT_LFS_SKIP_SMUDGE: "1"`. Unit test: on merge rejection the service issues the
  diff/hash-object/checkout cleanup calls. E2E (local remote, required failing filter on the first
  run): after the failed sync `git status --porcelain` in worktreeDir is empty; a second run with
  the filter fixed fast-forwards and reports `updated`. Existing test `propagates a non-missing-ref
  failure from the LFS-disabled retry fetch` must keep passing.
- **Notes**: Re-verified: `buildGitEnv` honours only `config.skipLfs`
  (clone-sync.service.ts:184-190); the retry policy's `setLfsSkipEnabled` toggles
  `GitService.lfsSkipOverride`, which clone-mode clients never consult, so the ff-merge at line 1013
  retries with LFS still enabled. Also reported as: “Retry policy's LFS-skip override never reaches
  clone-mode git clients, so the documented 'retry with LFS disabled' cannot succeed in clone mode”.

### [ ] T15. `fetch --unshallow` is the only fetch without `--progress`; with stderr piped it is silent until completion, so simple-git's 300 s inactivity timeout kills any unshallow that takes longer — the repo can never unshallow and every tick hard-fails

- **Category**: correctness · **Subsystem**: clone-sync
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/clone-sync.service.ts:295-304`
  (`CloneSyncService.unshallowIfDepthRemoved`), `src/services/clone-sync.service.ts:103-106,
  112-123, 173-175` (`getFetchTimeoutMs / buildGitOptions / clientFor`),
  `src/services/clone-sync.service.ts:857, 899-907` (`runSyncAttemptInternal (client + unshallow
  call)`)
- **Current behavior**: `unshallowIfDepthRemoved` runs `git.fetch(["--unshallow", "--no-tags"])` on
  a client built with `timeout: { block: fetchTimeoutMs }` (default 300 000 ms). simple-git 3.36's
  timeout plugin resets its timer on every stdout/stderr chunk and kills the child on `block` ms of
  silence (node_modules/simple-git/dist/cjs/index.js ~1505-1530). Without `--progress` git
  suppresses all transfer/delta progress when stderr is not a TTY and asks the server for
  `no-progress`; the command prints nothing until it finishes. Every other clone/fetch/deepen in the
  file passes `--progress` (lines 193, 205, 323-331). Failure scenario: Monorepo clone created with
  `depth: 1`; user removes `depth` (the documented way to unshallow, README line 425). Full history
  is multi-GB; "Receiving objects"/"Resolving deltas" exceed 5 minutes. Each tick: `[deepen] ...
  fetching full history...` → after 300 s of silence simple-git kills git (`GitPluginError: block
  timeout reached`), the partial pack is discarded, `isMissingRemoteRefError` is false so the error
  escapes (line 906), `retry()` re-runs it up to 3× (≈15 min per tick), sync exits 1. Repeats every
  tick; the repo is never unshallowed. Verified (scratch exp6, git 2.43, stderr piped): `git fetch
  --unshallow --no-tags 2>&1 | cat` produced zero bytes of output; with `--progress` it streamed
  `remote: Counting objects ...` lines.
- **Expected behavior**: Pass `--progress` to the unshallow fetch (`["--unshallow", "--no-tags",
  "--progress"]`) so the inactivity timer is fed and progress events reach the TUI/MCP like every
  other fetch. Consider using `getCloneTimeoutMs()` (900 s) for the unshallow client since it is
  clone-sized work.
- **Acceptance**: Update unit tests at clone-sync.service.test.ts:838 and :920 to expect
  `["--unshallow", "--no-tags", "--progress"]`; add an assertion that the progress emitter receives
  a `fetch` phase event during unshallow (via a mocked simple-git progress callback). Manual/e2e
  note: unshallowing a large local repo with `fetchTimeoutMs` set to a few seconds must complete
  instead of failing with `block timeout reached`.
- **Notes**: Re-verified: `git.fetch(['--unshallow', '--no-tags'])` (clone-sync.service.ts:303) is
  the only fetch without `--progress`, and `clientFor` applies the inactivity `timeout.block` of
  `fetchTimeoutMs` (5 min default).

### [ ] T16. TUI branch-creation wizard cannot create branches for clone-mode repos: createAndPushBranch targets a nonexistent bare repo path, so clone-mode branch switching (CHANGELOG 5.0.0) is unreachable

- **Category**: correctness · **Subsystem**: clone-sync
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/InteractiveUIService.tsx:545-591`
  (`InteractiveUIService.createAndPushBranch`), `src/services/InteractiveUIService.tsx:775-797`
  (`InteractiveUIService.createWorktreeForBranch`), `src/services/git.service.ts:1471-1484`
  (`GitService.createBranch / pushBranch`), `src/services/git.service.ts:59` (`GitService
  constructor (bareRepoPath)`), `src/utils/git-url.ts:113-116` (`getDefaultBareRepoDir`),
  `src/components/BranchCreationWizard.tsx:152-183` (`handleCreateBranch`),
  `src/services/clone-sync.service.ts:445-551` (`CloneSyncService.checkoutBranch`)
- **Current behavior**: The wizard always calls `createAndPushBranch(repoIndex, baseBranch, name)`
  (BranchCreationWizard.tsx:165) and only on success proceeds to `createWorktreeForBranch`, which is
  the single call site of `CloneSyncService.checkoutBranch` (line 789, `allowConfigDrift:true`).
  `createAndPushBranch` has no clone-mode branch: it calls `gitService.createBranch` / `pushBranch`,
  which run in `this.bareRepoPath`. For a clone-mode repo `bareRepoDir` is deliberately undefined
  (config-loader clone-mode test line 289-305), so `bareRepoPath = getDefaultBareRepoDir(repoUrl)` =
  the RELATIVE path `.bare/<repo>`; `getCachedGit('.bare/<repo>')` -> `simpleGit(dir)` throws
  'Cannot use simple-git on a directory that does not exist' (or, if the daemon happens to run from
  a config dir where a worktree-mode entry of the same repo lives, silently operates on that other
  repo's bare store). The wizard shows that error as the result; `checkoutBranch` is never reached,
  so the feature described in CHANGELOG 5.0.0 ('the branch picker checks out the selected branch in
  place when the repository is in clone mode') is not usable, and the comment at
  InteractiveUIService.tsx:787 ('The wizard just created and pushed this branch') can never be true.
  Failure scenario: TUI, clone-mode repo selected, wizard: pick base 'main', type 'feature/x', Enter
  -> RESULT screen shows 'Cannot use simple-git on a directory that does not exist' (no repo/branch
  context, no hint). No branch is created or pushed; the clone stays on its configured branch.
- **Expected behavior**: Add a clone-mode path to branch creation: when `service.isCloneMode()`,
  create the branch in the clone itself — e.g. a new
  `CloneSyncService.createAndPushBranch(baseBranch, name)` that runs inside the clone dir: `git
  branch --no-track <name> origin/<base>` (fetching `origin/<base>` with the narrowed refspec first
  if it is not the tracked branch), `git push -u origin <name>:<name>` using the same
  `buildGitEnv()` clients — then `checkoutBranch(name, {allowConfigDrift:true})` as today.
  Alternatively hide/disable the wizard for clone-mode repos with an explicit message. Either way
  the error must never be a bare simple-git constructor message; it must name the repo and say what
  to do.
- **Acceptance**: interactive-ui.service.test.ts: with a clone-mode sync service (`isCloneMode()`
  true) `createAndPushBranch(0,'main','feature/x')` must not call
  `gitService.createBranch`/`pushBranch`; it must call the clone-mode creation path and resolve
  `{success:true}`; the subsequent `createWorktreeForBranch` calls
  `checkoutBranch('feature/x',{allowConfigDrift:true})`. clone-sync.service.test.ts: new-branch
  creation issues `branch --no-track` + `push -u` in the worktree dir with the LC_ALL=C env, and a
  push failure leaves no local branch behind (or reports partial state explicitly). Manual: wizard
  creates and switches a clone-mode repo end-to-end.
- **Notes**: Guards checked: Searched InteractiveUIService.createAndPushBranch for an
  `isCloneMode()` branch (none; only `createWorktreeForBranch`, `fetchForRepo`, `getBranchesForRepo`
  have one). Tests at interactive-ui.service.test.ts:1698-1730 use a worktree-mode mock GitService
  so the missing branch is not exercised; clone-sync tests drive `checkoutBranch` directly with
  `initialized=true`. F10/F13 addressed the MCP handler, not the TUI.

### [ ] T17. Bare clone leaves stale refs/heads/* copies of every remote branch; the 'local && remote' worktree-add path checks out that stale tip and the same sync never fast-forwards it

- **Category**: correctness · **Subsystem**: git
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/git.service.ts:126` (`GitService.initialize (git clone --bare)`),
  `src/services/git.service.ts:135-149` (`GitService.initialize (fetch refspec only targets
  refs/remotes/origin/*)`), `src/services/git.service.ts:589-597, 768-782` (`GitService.addWorktree
  / runWorktreeAddByMatrix`), `src/services/git.service.ts:197-207` (`GitService.initialize (default
  worktree from local ref)`), `src/services/git.service.ts:1427-1445` (`GitService.branchExists`),
  `src/services/worktree-mode-sync-runner.ts:83-103` (`WorktreeModeSyncRunner.runSyncAttempt (plan
  computed before creates)`)
- **Current behavior**: `git clone --bare` copies every remote branch into `refs/heads/*`. The tool
  then adds `+refs/heads/*:refs/remotes/origin/*` and only ever fetches into
  `refs/remotes/origin/*`, so the `refs/heads/*` copies are frozen at clone time forever.
  `branchExists()` reports `local: true` for all of them, so `runWorktreeAddByMatrix` takes the
  `localExists && remoteExists` branch: `git worktree add <path> <branch>` (checkout of the frozen
  local tip) followed by `--set-upstream-to`. Metadata records `lastSyncCommit` = that stale tip.
  Because `syncPlan.update` is computed from the pre-creation inventory (runner 83-103), the new
  worktree is not fast-forwarded in the same sync. Failure scenario: Bare repo cloned in January. In
  March the user adds `feature/x` to `branchInclude` (or a filter change / age window admits it).
  `origin/feature/x` has been rebased since January. Sync logs `Created worktree for 'feature/x'
  with tracking to origin/feature/x` but the directory contains the January tree. On the next tick
  the branch is classified `diverged`, `handleDivergedBranch` runs `resetToUpstream` (`checkout
  -B`), logging a scary '⚠️ Branch has diverged from upstream' and recording
  `reset_no_local_changes`. If the user committed in the worktree in between (they see a fresh
  checkout and start working), the worktree is trashed via diverged-replace and recreated. A
  non-rebased branch simply stays behind for one full cron interval while the log says it was
  created with tracking.
- **Expected behavior**: A newly created worktree must start at the current `origin/<branch>` tip.
  Either (a) initialize the bare repo without local copies (`git init --bare` + `remote add` +
  fetch, or delete `refs/heads/*` that have no worktree right after the bare clone), or (b) in the
  `localExists && remoteExists` path, when `rev-list --count origin/<b>..<b>` is 0 create with
  `worktree add -B <b> <path> origin/<b>` (or ff-merge immediately after add), and if the local ref
  has local-only commits leave it and log why. Additionally, the update phase should include
  worktrees created in the same sync (or `addWorktree` should return the created HEAD so the runner
  can verify it equals the remote tip).
- **Acceptance**: E2E: clone bare via `GitService.initialize`; advance and then rebase `feature` on
  the remote; fetch; call `addWorktree('feature', path)`. Assert `git -C path rev-parse HEAD` ===
  `git -C bare rev-parse refs/remotes/origin/feature` immediately after the call, and that no
  `diverged`/`reset_no_local_changes` outcome is recorded on the following sync. Unit test: with
  `branchExists` returning `{local:true, remote:true}` and the local ref behind the remote, the
  emitted git argv resets/ff's to `origin/<branch>`. Existing test 'should add worktree and set
  upstream when branch exists locally' (git.service.test.ts:614) must be updated accordingly.
- **Notes**: Confirmed by the finder's experiment: after `git clone --bare` and a fetch with the
  tool's refspec, `refs/heads/feature` stayed at the clone-time commit while
  `refs/remotes/origin/feature` advanced, and `worktree add <path> feature` checked out the stale
  tip. Option (a) — initialize with `git init --bare` + `remote add` + fetch, or delete unattached
  `refs/heads/*` right after cloning — removes the whole class; option (b) patches the create path
  only.

### [ ] T18. Default-branch detection is frozen to a dangling `refs/remotes/origin/HEAD`; after the remote renames its default branch every sync fails in the update phase and the old default is never pruned

- **Category**: correctness · **Subsystem**: git
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/git.service.ts:1097-1135` (`GitService.detectDefaultBranch`),
  `src/services/git.service.ts:151-153` (`GitService.initialize (detected once per process)`),
  `src/services/worktree-mode-sync-runner.ts:271-283` (`WorktreeModeSyncRunner.resolveSyncBranches
  (forces default into inventory)`), `src/services/worktree-mode-sync-runner.ts:814-822, 965-999`
  (`updateExistingWorktrees / handleDivergedBranch`), `src/services/git.service.ts:1364-1384`
  (`GitService.resetToUpstream (ls-tree origin/<branch> throws)`), `src/index.ts:157, 176` (`runOnce
  exit code from outcome failures`)
- **Current behavior**: `detectDefaultBranch` trusts `git symbolic-ref refs/remotes/origin/HEAD`;
  `remote set-head origin -a` only runs when the symref is absent. `git fetch --prune` never touches
  the symref, so after the remote renames/deletes its default branch the symref still points at the
  old name. `resolveSyncBranches` then force-appends the old default to `remoteBranches` although
  `origin/<old>` no longer exists. Failure scenario: Remote migrates `master`→`main` (or
  `main`→`trunk`) and deletes the old branch. Tool keeps `defaultBranch = master`. Planner: `master`
  worktree stays an update candidate. `canFastForward` fails (`origin/master` missing) →
  `isLocalAheadOfRemote` false → `diverged` → `handleDivergedBranch` → `compareTreeContent` logs
  'Error comparing tree content' → `hasLocalChangesSinceLastSync` false → `resetToUpstream` rejects
  at `ls-tree origin/master` → recorded `diverged_recovery_failed` on every tick; runOnce exits 1
  forever (index.ts:157,176). The new default is created as a hashed peer directory, and the stale
  `master` worktree is never pruned because it is forced into the inventory.
- **Expected behavior**: On each initialize (or at least whenever `origin/<detectedDefault>` is
  absent from the fetched remote branches), re-resolve the default via `git remote set-head origin
  -a` (or `ls-remote --symref origin HEAD`, which clone mode already uses) and update
  `defaultBranch`/`mainWorktreePath`. When the previously detected default no longer exists on the
  remote, stop force-retaining it in `resolveSyncBranches` so it flows through the normal prune
  pipeline, and log a clear 'default branch changed from X to Y' message.
- **Acceptance**: E2E (pattern of src/__tests__/e2e/stale-registration.test.ts): bare repo
  initialized against a remote whose default is `main`; rename remote default to `trunk` and delete
  `main`; run `initialize()`+`sync()`. Assert `getDefaultBranch()` === 'trunk', the sync outcome has
  `failed === 0`, `main` appears as a prune candidate (skipped or removed per safety checks), and a
  `trunk` worktree exists. Unit test for `detectDefaultBranch`: symref target not present in `branch
  -r` output ⇒ `remote set-head origin -a` is invoked and its result used.
- **Notes**: Re-verified: `detectDefaultBranch` (git.service.ts:1097-1107) trusts the cached symref
  and only runs `remote set-head -a` when it is absent; `resolveSyncBranches` (runner 271-283) then
  force-appends the stale name.

### [ ] T19. Unpushed-commit probe uses the bare branch name as a revision; a tag with the same name shadows the branch and reports 0 unpushed commits with exit 0

- **Category**: correctness · **Subsystem**: git
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/worktree-status.service.ts:262`
  (`WorktreeStatusService.collectSnapshot (rev-list --count <branch> --not --remotes)`),
  `src/services/worktree-status.service.ts:442` (`WorktreeStatusService.hasUnpushedCommits`),
  `src/services/worktree-status.service.ts:165-167, 197-203` (`getFullWorktreeStatus canRemove
  derivation`)
- **Current behavior**: `git rev-list --count <currentBranch> --not --remotes` passes the short
  branch name. Git's ref resolution order tries `refs/tags/<name>` before `refs/heads/<name>`, so
  when a tag shares the branch name the tag wins; git only emits `warning: refname 'x' is
  ambiguous.` on stderr with exit 0, which simple-git treats as success. Failure scenario: Branch
  `release-1` created from tag `release-1` (hotfix workflow: `git checkout -b 1.4.2 1.4.2`), user
  commits locally in the worktree and never pushes; remote branch later deleted or filtered out.
  `rev-list --count release-1 --not --remotes` returns 0 (tag commit is on the remote).
  `hasUnpushedCommits` becomes false, `canRemove` true, and the prune pipeline removes the worktree.
  With trash enabled the payload + pin ref keep it recoverable for the retention window; with trash
  disabled the non-forced `worktree remove` deletes the directory (the local branch ref survives, so
  commits are not lost but the worktree is removed while the status says 'clean, nothing unpushed').
- **Expected behavior**: Use an unambiguous revision: `HEAD` (the worktree's HEAD is the branch) or
  `refs/heads/<branch>` in both rev-list invocations, and in any other place a short branch name is
  used as a revision. Optionally detect the ambiguity warning on stderr and fail closed.
- **Acceptance**: Unit test with a real temp repo: create tag `t` and branch `t`, add a local commit
  on branch `t`, no remote copy; `getFullWorktreeStatus` must report `hasUnpushedCommits: true` and
  `canRemove: false`. Assert the spawned argv contains `refs/heads/t` or `HEAD`, never bare `t`.
- **Notes**: Git resolves a bare name as `refs/tags/<name>` before `refs/heads/<name>`; use
  `refs/heads/${branch}` in `rev-list --count` (worktree-status.service.ts:262, 442). Removal is
  trash-backed, so the exposure is a wrong 'safe to remove' verdict rather than permanent loss.

### [ ] T20. Uninitialized submodules (`-` status) are classified as 'modified submodules', so every worktree of a repo with submodules is permanently un-prunable, flagged ⊞, and blocked from sparse narrowing

- **Category**: correctness · **Subsystem**: git
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/worktree-status.service.ts:364-375`
  (`WorktreeStatusService.deriveModifiedSubmodules`),
  `src/services/worktree-status.service.ts:507-528` (`WorktreeStatusService.hasModifiedSubmodules`),
  `src/services/worktree-status.service.ts:180, 191, 197-203` (`getFullWorktreeStatus
  (hasModifiedSubmodules → canRemove)`), `src/constants.ts:14-15`
  (`GIT_CONSTANTS.SUBMODULE_STATUS_REMOVED`), `src/services/worktree-mode-sync-runner.ts:137-150`
  (`reapplySparseCheckout narrowing gate`), `src/components/WorktreeStatusView.tsx:85-90` (`⊞ flag`)
- **Current behavior**: `git worktree add` never initializes submodules, so `git submodule status`
  prints `-<sha> path` for every submodule in every tool-created worktree.
  `deriveModifiedSubmodules` treats a leading `-` (git's 'not initialized' marker) the same as `+`
  (checked-out commit differs), so `hasModifiedSubmodules` is true for all of them. `canRemove` is
  then false with reason 'modified submodules'. The regex `^[+-]\s*(\S+)` also captures the SHA
  rather than the path, so `details.modifiedSubmodules` lists hashes. Failure scenario: Repo with
  one `.gitmodules` entry. Branch `feature/a` is deleted upstream; the worktree is clean and fully
  pushed. Every sync logs `Skipping removal of 'feature/a' due to: modified submodules` and records
  `unsafe_to_remove`; the directory is never trashed. The TUI status view shows ⊞ on every worktree;
  sparse-checkout narrowing is skipped for all of them with the same reason.
- **Expected behavior**: Only `+` (and `U` merge-conflict) lines should count as modified; `-` means
  the submodule is not checked out and cannot hold local work, so it must not block removal. Capture
  the path (`^[+-U]\S+\s+(\S+)`) for details. Consider recursing (`--recursive`) only for
  initialized submodules, consistent with the 5.2.0 note.
- **Acceptance**: Unit test: `submodule status` output `-6f73556 libs/sub` ⇒ `hasModifiedSubmodules`
  false, `canRemove` true; output `+6f73556 libs/sub (heads/main)` ⇒ true and
  `details.modifiedSubmodules` equals `['libs/sub']`. E2E: bare repo of a superproject with an
  uninitialized submodule; a clean, pushed, upstream-deleted worktree is pruned/trashed.
- **Notes**: `git submodule status` prefixes `-` for an uninitialized submodule and `+` for a
  checked-out commit that differs from the index; only `+` (and `U`) mean modified.
  `deriveModifiedSubmodules` (364-375) and `hasModifiedSubmodules` (507-528) treat `-` as modified.

### [ ] T21. initialize() creates the default-branch worktree with a raw `worktree add` and treats git's 'already exists' as success; a pre-existing unregistered directory leaves the service pointed at a non-repository and every later sync fails at fetch

- **Category**: guardrail · **Subsystem**: git
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/git.service.ts:203-231` (`GitService.initialize (worktree add +
  'already exists' swallow)`), `src/services/git.service.ts:233-244` (`GitService.initialize
  (registration check only warns)`), `src/services/git.service.ts:248, 325-336` (`this.git =
  getCachedGit(mainWorktreePath); fetchAll/fetchBranch run there`),
  `src/services/git.service.ts:565-585, 978-1027` (`addWorktree / clearStaleWorktreeDirectory (the
  safe path not used for the default branch)`), `src/services/__tests__/git.service.test.ts:267-284`
  (`test enshrining the swallow`)
- **Current behavior**: Non-default branches go through `addWorktree`, which trashes/quarantines an
  unregistered directory before `worktree add`. The default branch is created directly with
  `bareGit.raw(['worktree','add',...])`; if git says `fatal: '<path>' already exists`, the code logs
  info 'already exists, skipping creation', warns 'Main worktree was created but not found in
  worktree list', and still sets `this.git` to that directory. `initialize()` resolves,
  `isInitialized()` is true, and MCP `initialize` reports success. Failure scenario: User deletes
  `.bare/` to recover from corruption (or points `bareRepoDir` at a new location) but keeps
  `worktrees/`. `worktrees/main/.git` is a gitfile pointing at the dead admin dir. Every `sync()`
  then runs `fetch --all --prune` inside `worktrees/main` → `fatal: not a git repository: <old
  bare>/worktrees/main`, retried 3×, failing every tick. Same outcome if `worktrees/main` is any
  non-empty directory.
- **Expected behavior**: The default-branch worktree must be created through the same path as every
  other branch (`addWorktree`, or `clearStaleWorktreeDirectory` before `worktree add`), so a stale
  directory is moved to trash/quarantine (never silently reused) and creation proceeds. If after
  creation the path is still not a registered worktree, `initialize()` must reject with an error
  naming the path, not warn and continue.
- **Acceptance**: Test: bare repo + pre-existing `worktreeDir/main` containing a `.git` gitfile that
  points nowhere. `initialize()` must either move it to `.trash`/`.removed` (audit record written)
  and create a registered worktree, or reject with an error mentioning the path; `fs.rm` is never
  called on a directory containing `.git`; `getWorktrees()` afterwards includes `worktreeDir/main`.
  Update git.service.test.ts:267-284 to assert rejection or quarantine instead of a silent pass.
  Manual check: `sync()` after such an init succeeds.
- **Notes**: Guards checked: Round-1 #17 and CHANGELOG 5.3.1 cover the mirror case (registration
  present, directory missing). The 'already exists' swallow was written for the benign race where
  git raced itself; it now masks a permanent misconfiguration. Verified in scratch exp1: after
  re-cloning the bare repo with an existing worktree dir, `worktree add` failed with 'already
  exists' and `git status` inside reported 'not a git repository: .../bare2/worktrees/wt-b2'.

### [ ] T22. Worktree mode never checks that an existing bare repo's origin URL matches config.repoUrl (clone mode does), so a changed repoUrl silently keeps syncing the old remote

- **Category**: guardrail · **Subsystem**: git
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/git.service.ts:112-149` (`GitService.initialize (HEAD-exists check,
  then fetch)`), `src/services/git.service.ts:59` (`bareRepoPath derived from repo name only`),
  `src/services/clone-sync.service.ts:696-716` (`origin_mismatch check in clone mode (for
  contrast)`), `src/utils/git-url.ts:64-77` (`normalizeRepoUrlForComparison (available helper)`)
- **Current behavior**: `initialize()` decides 'bare repo exists' solely from `<bareRepoDir>/HEAD`
  and proceeds to `fetch --all` using whatever `remote.origin.url` the bare repo has. The default
  `bareRepoDir` is `.bare/<repo-name>`, which is identical for `github.com/old-org/app.git` and
  `gitlab.com/new-org/app.git`. Failure scenario: Org migrates hosts or the user switches from a
  fork to upstream and edits `repoUrl`. `.bare/app` already exists with the old origin. Every sync
  fetches the old remote: new upstream branches never appear, branches deleted on the old remote are
  pruned locally, and nothing in the log mentions the mismatch. If the old remote is a redirecting
  archive the fetch keeps succeeding indefinitely.
- **Expected behavior**: After confirming the bare repo exists, read `git config remote.origin.url`
  and compare with `normalizeRepoUrlForComparison(config.repoUrl)`. On mismatch, fail initialization
  (or record a skip) with a message that names both URLs and suggests `git -C <bare> remote set-url
  origin <url>` or a fresh `bareRepoDir` — mirroring clone mode's `origin_mismatch`.
- **Acceptance**: Unit test: bare repo whose `remote.origin.url` differs from `config.repoUrl` ⇒
  `initialize()` rejects (or records an `origin_mismatch` skip) and no fetch is issued; equal URLs
  modulo `.git`/trailing slash/host case ⇒ proceeds. E2E variant with two local remotes.
- **Notes**: Guards checked: Only clone-sync implements the origin check; `GitService.initialize`
  has no equivalent and the loader's duplicate-bareRepoDir validation is per-file, not per-remote.
  No test covers a repoUrl change against an existing bare repo.

### [ ] T23. `fetchTimeoutMs` is applied as an inactivity kill to every command on cached clients (worktree add checkout, ff-merge, checkout HEAD, status); `worktree add` is silent during checkout, so large-repo creation is SIGINT'd after 5 min and can never succeed

- **Category**: correctness · **Subsystem**: git
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/git.service.ts:80-91` (`GitService.getCachedGit (uses
  getFetchTimeoutMs for every client)`), `src/services/git.service.ts:93-105`
  (`GitService.buildSimpleGitOptions (timeout.block)`), `src/services/git.service.ts:559, 769,
  791-800, 1173-1179, 1365-1392` (`worktree add / merge / checkout on those clients`),
  `node_modules/simple-git/dist/esm/index.js:4500-4535, 1418-1424` (`timeout plugin (block resets
  only on stdout/stderr data; kill → SIGINT)`), `src/types/index.ts:206-211` (`fetchTimeoutMs doc
  comment`), `README.md:621` (`points to example config for timeouts; example has no timeout
  entries`)
- **Current behavior**: Every `getCachedGit` client is built with `timeout: { block: fetchTimeoutMs
  }` (default 300 s). simple-git's timeout plugin kills the child with SIGINT when no stdout/stderr
  data arrives within the window. `git worktree add` prints 'Preparing worktree …' then runs an
  internal `reset --hard` that emits no progress on a pipe, then 'HEAD is now at …'. The knob is
  documented (types) as a fetch/standard-op timeout and is absent from the example config the README
  points to. Failure scenario: Monorepo whose checkout takes > 5 min (millions of files, slow
  disk/NFS, or LFS smudge downloads with skipLfs=false). Phase 2 `addWorktree` is killed with 'block
  timeout reached'; git's signal handler removes the partial worktree (or leaves a partial directory
  that is trashed next tick), the runner records `create_failed`, and the same thing happens every
  tick. The error text never mentions `fetchTimeoutMs`, and the example config does not document the
  knob.
- **Expected behavior**: Apply the inactivity timeout only to network commands
  (fetch/clone/ls-remote/push) via a dedicated client or per-call option; local commands (`worktree
  add`, `merge`, `checkout`, `status`, `ls-files`, `gc`) should run without a silence-based kill (or
  with a separate, generously defaulted `localOpTimeoutMs`). Document
  `fetchTimeoutMs`/`cloneTimeoutMs` in sync-worktrees.config.example.js and README.
- **Acceptance**: Unit test: `addWorktree`, `updateWorktree`, `resetToUpstream`, `checkoutHead` are
  issued through a simple-git client whose options carry no `timeout.block` (or a distinct local
  timeout), while `fetchAll`/`fetchBranch`/`initialize` clone keep theirs. Example config gains
  commented `fetchTimeoutMs`/`cloneTimeoutMs` entries. Manual: a worktree add exceeding
  `fetchTimeoutMs` completes.
- **Notes**: simple-git's `timeout.block` is an inactivity timeout; `getCachedGit`
  (git.service.ts:80-91) applies `fetchTimeoutMs` to every cached client, including the ones used
  for `worktree add`, `merge --ff-only`, `checkout HEAD` and `status`.

### [ ] T24. removeWorktree only classifies git's 'dirty' refusal; locked worktrees and worktrees with initialized submodules turn into hard `remove_failed` failures (exit 1) every tick, and the `locked` flag parsed from `worktree list` is discarded

- **Category**: guardrail · **Subsystem**: git
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/git.service.ts:845-863` (`GitService.removeWorktree (regex only
  matches dirty refusal)`), `src/services/git.service.ts:1490-1502`
  (`GitService.getWorktreesFromBare (drops parsed `locked`)`),
  `src/utils/worktree-list-parser.ts:42-43` (`locked parsing`),
  `src/services/worktree-mode-sync-runner.ts:596, 606-631` (`pruneOldWorktrees non-trash removal and
  error classification`), `src/services/trash.service.ts:323-359` (`trashAndUnregisterWorktree
  (rename then force-remove, rollback on failure)`)
- **Current behavior**: `git worktree remove` (with or without a single `--force`) refuses locked
  worktrees ('cannot remove a locked working tree … use remove -f -f') and, without `--force`,
  worktrees containing initialized submodules ('working trees containing submodules cannot be moved
  or removed'). Neither message matches `/contains modified or untracked files|use --force/i`, so
  the error is rethrown as a generic failure. With trash enabled a locked worktree is renamed into
  `.trash/…/payload`, the force-remove fails, the payload is renamed back and a `trash_failed` skip
  is recorded — repeating the `du` size scan and two renames of the whole worktree every tick. With
  trash disabled both cases record `remove_failed`, which sets a non-zero exit code in runOnce.
  Failure scenario: User runs `git worktree lock --reason 'demo box' worktrees/feature-x-…` to
  protect a worktree, or runs `git submodule update --init` inside a worktree and later the remote
  branch is deleted. With `trash.enabled=false`, every sync logs '❌ Failed to remove worktree' and
  exits 1 in CI; with trash enabled the locked worktree is moved out and back every tick.
- **Expected behavior**: Surface `locked` from `getWorktrees()` and treat locked worktrees as a
  deliberate skip (`worktree_locked`, with the lock reason) before any status probe or rename.
  Classify git's locked and submodule refusals as `WorktreeNotCleanError`-style skips, not failures.
  For the trash path, check `locked` before `trashDirectory` so no rename round-trip happens.
- **Acceptance**: Unit tests: `removeWorktree` throwing 'cannot remove a locked working tree' or
  'working trees containing submodules cannot be moved or removed' ⇒ runner records a skip (not
  `remove_failed`) and `process.exitCode` stays 0; `getWorktrees()` returns `locked: true` for a
  `locked` porcelain entry; prune of a locked worktree never calls `trashDirectory`/`fs.rename`.
  E2E: lock a worktree, delete its remote branch, sync ⇒ outcome skip with reason containing
  'locked'.
- **Notes**: Guards checked: CHANGELOG 5.2.0 introduced the non-forced remove so git's dirty refusal
  becomes a skip, but only that one message is matched. The parser already extracts `locked`, yet
  `getWorktreesFromBare` maps it away. Verified refusal messages and exit codes with git 2.43 in
  scratch.

### [ ] T25. TUI worktree status view fans out getFullWorktreeStatus over every worktree with no concurrency limit (≥6 git processes each)

- **Category**: performance · **Subsystem**: git
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/InteractiveUIService.tsx:602-621`
  (`InteractiveUIService.getWorktreeStatusForRepo`),
  `src/services/worktree-status.service.ts:228-247, 257-282` (`collectSnapshot (6 + up to 4 parallel
  spawns per worktree)`)
- **Current behavior**: `getWorktreeStatusForRepo` maps every worktree straight into
  `Promise.allSettled` without `pLimit`; each `getFullWorktreeStatus` spawns 6 git processes in
  parallel (plus up to 4 more), each `git branch -v -a` walking all refs. Failure scenario: Repo
  with 300 worktrees, user presses `w`: ~1800 concurrent git processes are spawned at once; the box
  hits EAGAIN/EMFILE or thrashes, individual probes fail and are silently dropped by the `fulfilled`
  filter, so the view shows fewer worktrees than exist with no error.
- **Expected behavior**: Bound the fan-out with `pLimit(config.parallelism?.maxStatusChecks ??
  DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS)` (as the runner does) and report rejected probes
  instead of dropping them.
- **Acceptance**: Unit test with a mocked `getFullWorktreeStatus` that records in-flight count: with
  50 worktrees and maxStatusChecks 5, max in-flight ≤ 5; rejected entries appear in the result with
  an error field.
- **Notes**: Same fan-out was reported independently by the git, TUI and process reviewers; the sync
  path already bounds status checks with `maxStatusChecks` (worktree-mode-sync-runner.ts:465-477),
  so reuse that limit (or `pLimit(DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS)` as the MCP handlers
  do) and surface rejected probes instead of dropping them (InteractiveUIService.tsx:618-620). Also
  reported as: “`w` status view spawns ~10 git processes per worktree for every worktree at once (no
  p-limit) and silently drops entries whose probe rejected”; “TUI worktree-status view (`w`) fans
  out getFullWorktreeStatus for every worktree with no concurrency limit: ~10 git processes per
  worktree launched simultaneously (thousands on large repos), unlike the sync path which caps
  status checks at maxStatusChecks”.

### [ ] T26. F7 fix incomplete: trash entries written by 5.0.x/5.1.0 (flat pin refs) are rejected as invalid manifests forever — never listed, never restorable, never reaped, pin refs never released

- **Category**: correctness · **Subsystem**: trash
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/trash.service.ts:585-632` (`TrashService.readManifest`),
  `src/services/trash.service.ts:634-646` (`TrashService.isOwnPinRef`),
  `src/services/trash-reaper.service.ts:72-75, 221-230` (`TrashReaperService.reapUnlocked /
  reapOrphanedPinRefs`), `REVIEW_FINDINGS.md:173-191` (`F7`), `README.md:589-590`
- **Current behavior**: Trash shipped in 5.0.0 (commit 6bf58b5, 2026-06-11) writing flat pin refs
  `refs/sync-worktrees/trash/<id>` (old trash.service.ts:470) and manifests with no pinRef shape
  validation. F7 (commit 387b05e, 2026-07-08, i.e. 27 days later — inside the 30-day retention
  window) moved pins to `refs/sync-worktrees/trash/<rootHash>/<id>` and added `isOwnPinRef`, which
  requires a 16-hex rootHash segment. For a legacy manifest the computed rootHash is the empty
  string, the regex fails, and `readManifest` returns null, so every entry created before the
  upgrade is reported as `invalid`. `listEntries` hides it, `restore(id)` fails with "no trash entry
  with id", the reaper logs "leaving unrecognized entry ... alone (no valid manifest)" on every tick
  forever and never deletes the payload, and the orphan sweep deliberately leaves flat refs alone
  ("leaving legacy flat trash pin refs alone", also every tick). F7's own acceptance text said
  "Restore/reap must resolve both layouts during the transition"; only the reaper sweep side was
  done. Failure scenario: User on 5.0.1/5.1.0 has 12 trashed worktrees (up to 30 days old, some with
  `keepPinOnReap` never-pushed commits). Upgrade to >=5.1.1. Next sync: 12 warnings per tick,
  hourly, forever; `sync-worktrees trash --filter repo` lists nothing but 12 'Invalid trash entry
  left untouched' lines; `--restore <id>` fails; disk under `.trash/` never shrinks; the 12 flat pin
  refs keep their objects alive through every gc indefinitely. README line 590 ("so nothing stays
  pinned forever") is false for these.
- **Expected behavior**: `readManifest`/`isOwnPinRef` accept the legacy flat layout
  `TRASH_REF_PREFIX + id` (the `/<id>` suffix check still prevents a hand-edited manifest from
  aiming deleteRef at refs/heads/*), so legacy entries list, restore and reap normally; on reap the
  entry's own `manifest.pinRef` is deleted explicitly (already the case), which is enough for
  convergence without changing the sweep's leave-alone policy for flat refs of unknown owners.
  Optionally, the migration service rewrites legacy manifests/refs into the hashed namespace once
  (update-ref new, delete old, rewrite manifest atomically). The reaper should log the
  unrecognized/legacy warnings once per process, not once per tick.
- **Acceptance**: Unit test (trash.service.test.ts): create an entry, rewrite manifest.json with
  `pinRef: 'refs/sync-worktrees/trash/<id>'`, assert `listEntries()` returns it with `invalid: []`,
  `restore(id)` succeeds and calls `deleteRef('refs/sync-worktrees/trash/<id>')`. Reaper test: same
  legacy entry backdated past expiry is deleted and its flat pin ref is deleted via the manifest
  path while an unrelated flat ref without a container is still left alone. Verified empirically in
  scratch (esbuild-bundled TrashService, Node 22): legacy manifest -> `entries: 0 invalid: 1`,
  restore -> "no trash entry with id".
- **Notes**: Re-verified: `isOwnPinRef` (trash.service.ts:639-646) requires a 16-hex root-hash
  segment, so a pre-5.1.1 flat pin ref fails manifest validation; the reaper leaves invalid entries
  alone (trash-reaper.service.ts:72-75) and skips legacy flat refs in the sweep (223-229), so
  nothing ever releases them. F7's spec called for both layouts to stay resolvable during the
  transition.

### [ ] T27. A partially failed `fs.rm` of a trash container deletes manifest.json first and leaves an unrecognized, unreapable container whose pin ref is then kept forever

- **Category**: correctness · **Subsystem**: trash
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/trash-reaper.service.ts:135-150` (`TrashReaperService.reapUnlocked
  (fs.rm container)`), `src/services/trash-reaper.service.ts:152-161, 185-195, 237` (`pin delete
  after rm / reapOrphanedPinRefs keyed on container name`), `src/services/trash.service.ts:288-300,
  430-434, 648-653` (`listEntries invalid handling / restore container rm / undoPartialTrash`)
- **Current behavior**: The reaper (and restore's cleanup, and undoPartialTrash) delete the whole
  container with one `fs.rm(containerPath, {recursive:true, force:true})`. Node's recursive rm is
  not atomic and deletes siblings in readdir order; when a file deep in `payload/` cannot be
  unlinked (immutable attribute, file owned by another uid such as root-created build output from a
  Docker bind mount, EPERM on FUSE/overlay), rm throws after already removing `manifest.json`. On
  the error path the reaper does NOT delete the pin ref (line 152 is after the `continue`), and on
  later ticks `listEntries` classifies the container as invalid ("leaving unrecognized entry
  alone"), never retries the delete, and `reapOrphanedPinRefs` keeps the pin because the container
  name still exists (line 237). The payload was moved by rename at trash time (which does not need
  delete permission), so such worktrees are trashed fine and then can never be reaped. Failure
  scenario: Worktree contains `dist/` written by a root container via bind mount. Branch pruned ->
  trashed OK. 30 days later reaper: rm removes manifest.json and most of payload, fails on dist/ ->
  warning 'failed to delete'. Every subsequent tick: 'Trash reaper: leaving unrecognized entry ...
  alone (no valid manifest)'. Entry is invisible to `trash` CLI and force clean
  (`invalidTrashEntries`), disk is never reclaimed, and the pin ref keeps the trashed HEAD's objects
  alive through gc indefinitely. No message tells the user what to do.
- **Expected behavior**: Delete in an order that keeps the entry recognizable until the payload is
  gone: rename `payload/` to `payload.deleting-<ts>` (or rm `payload/` first), then remove
  bundle/manifest, then the container; a container whose manifest exists but whose payload is
  missing/partially deleted is treated as an expired payload-less entry and finishes on the next
  run. On rm failure, log the failing path with a hint (chown/chattr, delete manually) and keep the
  manifest intact. Same ordering in `restore`'s cleanup and `undoPartialTrash`.
- **Acceptance**: Reaper unit test with fs.rm mocked to delete manifest.json then throw EPERM: after
  the failed run the entry is still listed by `listEntries()` (not invalid); a second run with rm
  succeeding deletes it and its pin. Integration test on Linux with `chattr +i` on a payload file
  (skip if unavailable): first reap warns and leaves a valid manifest; after `chattr -i` the next
  reap completes. Verified in scratch on Node 22.22.2: container with manifest.json +
  payload/sub/file (chattr +i) -> `fs.rm` threw ENOTDIR-style error and `find` showed manifest.json
  gone while payload/sub/file remained.
- **Notes**: Re-verified: `fs.rm(container, {recursive:true})` (trash-reaper.service.ts:136) removes
  `manifest.json` before `payload/` (readdir order); on a mid-way failure the container is then
  'unrecognized' forever and its pin ref survives the orphan sweep because the container name still
  exists (line 237).

### [ ] T28. TUI force clean purges trash entries created after the confirmation preview: a cron sync that starts while the modal is open can trash worktrees that are then destroyed with gc --prune=now without ever being shown to the user

- **Category**: guardrail · **Subsystem**: trash
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/InteractiveUIService.tsx:746-772` (`InteractiveUIService.forceClean`),
  `src/components/ForceCleanModal.tsx:63-73` (`y handler`), `src/components/App.tsx:171-172` (`x key
  gating on status`), `src/services/InteractiveUIService.tsx:181-184, 935` (`cron tick ->
  runSyncCycle`), `src/services/worktree-sync.service.ts:226-266, 476-500`
  (`WorktreeSyncService.forceClean (wait:true)`), `src/services/trash-reaper.service.ts:46-48, 84`
  (`purgeAllUnlocked`)
- **Current behavior**: `x` is gated on `status !== 'syncing'` only at keypress. While the modal
  shows the preview counts, a cron tick (or the sync queued behind the previous op) starts and may
  trash worktrees (prune, diverged-replace, orphan). `y` calls `service.forceClean()` which queues
  on the repo mutex with `wait:true`, runs after that sync, and `purgeAllUnlocked()` deletes every
  valid entry present at run time — including entries with `keepPinOnReap` that hold the only copy
  of never-pushed commits — then deletes their pins and runs `git gc --prune=now`. The confirmation
  only pins the repo set (repoIndexes), not the entries. Failure scenario: Daemon with hourly cron.
  09:59:50 user presses x, sees 'repo: 3 trash (1.2 GB), 0 recovery refs'. 10:00:00 cron sync runs;
  a transient probe failure (round-1 #5/#18) or a real prune trashes 5 healthy worktrees, one with a
  diverged branch (keepPinOnReap, only copy). 10:00:40 user presses y; force clean runs after the
  sync, purges 8 entries and their pins, gc --prune=now collects the diverged commits. User
  confirmed 3 deletions; 5 unseen entries are irrecoverably gone.
- **Expected behavior**: The preview snapshot is the purge set: `ForceCleanPreview` carries the
  entry ids (per repo) and `forceClean` passes them to `purgeAllUnlocked(ids)`; entries not in the
  snapshot are left in place and reported (`skippedNewEntries`). Alternatively (or additionally)
  hold the repo mutex from preview to confirmation / block cron ticks while the modal is open, and
  re-render the counts if they change. Keep refs likewise snapshot by name.
- **Acceptance**: Unit test on WorktreeSyncService.forceClean: mock preview returning ids [a,b]; add
  entry c before forceClean runs; assert purge deleted a,b only and result reports c retained. TUI
  test: open modal, emit a sync that adds an entry, press y, assert forceClean was called with the
  preview's ids. Manual: open modal, trigger `s` from another path or wait for cron, confirm — new
  entry survives.
- **Notes**: Re-verified: `InteractiveUIService.forceClean` (746-773) only filters by repo index;
  `WorktreeSyncService.forceClean` (226-232) calls `purgeAllUnlocked` with no snapshot of the
  previewed entry ids.

### [ ] T29. No validation that two repositories share (or overlap) a worktreeDir: the second entry silently trashes the first entry's worktrees and adopts its default-branch checkout, while both report 'synced'

- **Category**: guardrail · **Subsystem**: config
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/config-loader.service.ts:750-765`
  (`ConfigLoaderService.detectBareRepoDirCollisions`),
  `src/services/config-loader.service.ts:725-739` (`validateWorktreeBareRepoSeparation`),
  `src/services/config-loader.service.ts:799-817` (`buildRepositories`),
  `src/services/git.service.ts:224-243` (`GitService.initialize (main worktree 'already exists'
  adoption)`), `src/services/git.service.ts:558-585, 978-1016` (`addWorktree /
  clearStaleWorktreeDirectory`), `src/utils/lock-path.ts:101-117` (`getWorktreeDirLockTarget`),
  `src/mcp/context.ts:200` (`RepositoryContext.loadConfig (calls detectBareRepoDirCollisions only)`)
- **Current behavior**: Config validation checks that two entries do not resolve to the same
  bareRepoDir (750-765) and that one entry's own bareRepoDir/worktreeDir do not nest (725-739), but
  nothing checks worktreeDir across entries, nor whether one entry's worktreeDir sits inside another
  entry's bareRepoDir (or vice versa). Two worktree-mode entries with the same worktreeDir therefore
  load fine. At runtime: (a) the second repo's GitService.initialize sees `<worktreeDir>/main`
  already exists, logs 'skipping creation', warns 'Main worktree was created but not found in
  worktree list' and continues; it then reports 'Found 0 managed Git worktrees' and 'All worktrees
  are up to date' forever; (b) for every hashed branch directory, the second repo's addWorktree
  finds a directory that is not registered in ITS bare repo and hands it to
  clearStaleWorktreeDirectory, which moves the first repo's checkout (including uncommitted work)
  into .trash and creates its own checkout at the same path; the first repo's registration now
  points at a directory whose .git file belongs to the other bare repo. The runOnce summary prints
  '2 synced, 0 failed' and exit code 0 throughout. When the two entries run concurrently (daemon or
  runOnce with maxRepositories>=2), the shared worktreeDir lock key makes the second one skip with
  the misleading message 'another process holds the lock' (same process). Failure scenario: Config:
  repositories [{name:'A', repoUrl:U, worktreeDir:'./wt'}, {name:'B', repoUrl:U, worktreeDir:'./wt',
  bareRepoDir:'./bareB'}] (copy-paste of an entry, or the documented duplicate-repoUrl sparse layout
  with a forgotten worktreeDir change). Run `sync-worktrees --runOnce` after a `feature` branch
  exists on the remote. Observed: A creates wt/feature-2ad56231; B logs 'Moved stale directory at
  .../wt/feature-2ad56231 to trash (.../wt/.trash/2026-...-feature-2ad56231-5068e7/payload)' and
  creates its own; `git -C bareA worktree list` and `git -C bareB worktree list` BOTH list
  wt/feature-2ad56231; summary: 'Processed 2 repos: 2 synced, 0 with clone-mode skips, 0 failed'.
  Any uncommitted work in A's checkout is now only in trash and ages out after retentionDays.
- **Expected behavior**: buildRepositories (and the MCP loadConfig path) must reject at load time,
  with a ConfigValidationError naming both repositories and the path, any two entries whose resolved
  worktreeDir compare equal under normalizePathForCompare (both modes), and any entry whose
  worktreeDir is equal to or inside another entry's bareRepoDir or whose bareRepoDir is equal to or
  inside another entry's worktreeDir. Nested worktreeDirs between two entries (A: /wt, B: /wt/sub)
  may be allowed but should at least warn. The existing detectBareRepoDirCollisions should become a
  general detectPathCollisions used by both src/index.ts and src/mcp/context.ts.
- **Acceptance**: Loader tests: (1) two worktree-mode repos with the same worktreeDir → throws
  ConfigValidationError mentioning both names; (2) worktree-mode repo A with worktreeDir '/x' and
  repo B with bareRepoDir '/x' (and the nested variant '/x/inner') → throws; (3) clone-mode +
  worktree-mode sharing worktreeDir → throws; (4) distinct dirs, and case-only differences on
  non-darwin, → passes; (5) on darwin, case-only duplicates → throws. Integration: the repro above
  (two entries, one worktreeDir) fails at `sync-worktrees list`/`--runOnce` with exit 1 before any
  git command runs; mcp context.loadConfig rejects the same config.
- **Notes**: Re-verified: `detectBareRepoDirCollisions` (config-loader.service.ts:750-765) is the
  only cross-repository check and it keys on `bareRepoDir`; `validateWorktreeBareRepoSeparation`
  (725-739) is per-repository.

### [ ] T30. All cross-process locking, git inactivity timeouts, trash reaping and gc are silently disabled whenever the inherited environment has NODE_ENV=test; the CLI only sets NODE_ENV when it is unset

- **Category**: guardrail · **Subsystem**: config
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `bin/sync-worktrees.js:5` (`process.env.NODE_ENV ??= "production"`),
  `src/services/repo-operation-lock.ts:29-32` (`RepoOperationLock.acquire`),
  `src/services/git.service.ts:70-78` (`getFetchTimeoutMs / getCloneTimeoutMs`),
  `src/services/clone-sync.service.ts:99-105`, `src/services/worktree-sync.service.ts:397-410`
  (`runMaintenanceIfDueUnlocked / runTrashMaintenanceUnlocked`), `src/constants.ts:96-100`
  (`ENV_CONSTANTS.NODE_ENV_TEST`), `src/__tests__/setup.ts:5`
- **Current behavior**: Five production code paths branch on the generic `NODE_ENV === "test"`:
  RepoOperationLock.acquire returns a no-op release (no bare-repo lock, no worktreeDir lock),
  fetch/clone inactivity timeouts become 0 (disabled), the trash reaper/legacy migration is skipped
  and periodic `git gc` is skipped. bin/sync-worktrees.js uses `??=`, so a NODE_ENV already exported
  by the caller's shell/CI/direnv/.env is kept as-is. Nothing logs that safety features are off.
  Failure scenario: A CI job or dev shell exports NODE_ENV=test (common for test stages, Jest/Vitest
  wrappers, direnv-loaded .env files). The user runs `sync-worktrees --runOnce` from that
  environment (e.g. as an e2e fixture bootstrap) while a daemon or a second cron invocation also
  syncs the same bare repo. With acquire() returning a no-op, both processes run `git
  fetch`/`worktree add`/`worktree prune`/trash moves concurrently on the same bare repo — exactly
  the race the 5.3.1 lock work exists to prevent. Additionally a stalled fetch never times out, and
  in a long-running daemon started from such a shell the .trash directory is never reaped and gc
  never runs, so disk usage grows indefinitely.
- **Expected behavior**: Production behaviour must not depend on NODE_ENV. Gate the test shortcuts
  on a dedicated, tool-owned variable set only by src/__tests__/setup.ts (e.g.
  SYNC_WORKTREES_UNIT_TEST=1 or vitest's VITEST env), and remove the NODE_ENV checks from
  repo-operation-lock, git.service, clone-sync.service and worktree-sync.service. If any shortcut
  remains env-controlled, log a prominent warning at startup when it is active.
- **Acceptance**: Unit test: with process.env.NODE_ENV='test' and the new test flag unset,
  RepoOperationLock.acquire() attempts a real proper-lockfile lock (mock lockfile.lock and assert it
  is called) and GitService.getFetchTimeoutMs() returns DEFAULT_CONFIG.FETCH_TIMEOUT_MS.
  Integration: `NODE_ENV=test node bin/sync-worktrees.js --runOnce` on a temp config creates the
  lock file under $XDG_STATE_HOME/sync-worktrees/locks and runs the trash reaper (a pre-seeded
  expired trash entry is deleted). Full suite still green with the setup.ts flag.
- **Notes**: Re-verified: `bin/sync-worktrees.js` uses `NODE_ENV ??= 'production'`, so an inherited
  `NODE_ENV=test` wins; `RepoOperationLock.acquire` (29-32) and
  `getFetchTimeoutMs`/`getCloneTimeoutMs` (git.service.ts:70-78, clone-sync.service.ts:98-106)
  short-circuit on it.

### [ ] T31. The shipped sync-worktrees.config.example.js fails validation ('experimental-features' sets runOnce) — the README's reference for 'every knob' cannot be loaded

- **Category**: docs · **Subsystem**: config
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `sync-worktrees.config.example.js:113-136` (`experimental-features entry (runOnce:
  true at line 123)`), `src/services/config-loader.service.ts:144-146` (`validateConfigFile per-repo
  runOnce rejection (F6)`), `README.md:621`
- **Current behavior**: F6 made per-repository `runOnce` a validation error ('cannot be set; use
  defaults.runOnce'), but the example config still carries `runOnce: true` on the
  'experimental-features' entry. Loading the example through ConfigLoaderService throws. README line
  621 sends users to this file for timeouts/parallelism/jitter/sparse-update/retry tuning; none of
  `fetchTimeoutMs`, `cloneTimeoutMs`, `skipUpdateWhenOutsideSparse`, `maxBranchFetches` or the
  `trash` block appear in it. The example's comment (lines 297-298) also states the clone-mode lock
  lives at `<configDir>/.sync-worktrees-state/<name>-<hash>.lock`, whereas lock-path.ts:108-117
  places it at `$XDG_STATE_HOME|~/.cache/sync-worktrees/locks/<hash>.lock`. Failure scenario: A new
  user copies sync-worktrees.config.example.js to sync-worktrees.config.js, trims the repositories
  they do not need but keeps the 'experimental-features' entry as a template, runs `sync-worktrees`
  and gets 'Error loading config file: Invalid configuration for 'Repository 'experimental-features'
  runOnce': cannot be set; use defaults.runOnce'. A user looking for a fetch timeout knob finds
  nothing in the example.
- **Expected behavior**: The example must load cleanly: drop `runOnce: true` from the repository
  entry (move the intent to a comment about defaults.runOnce). Document the knobs README promises
  (or fix README once fetch/clone timeouts are wired — see the separate timeout finding), add a
  `trash` block example, and correct the lock-path comment. Add a CI-level guard so the example
  cannot drift again.
- **Acceptance**: New test in src/services/__tests__/config-loader.service.test.ts (or a small e2e)
  that runs `new ConfigLoaderService().buildRepositories('<repo>/sync-worktrees.config.example.js')`
  and expects success with the documented repository count; `grep -n runOnce
  sync-worktrees.config.example.js` shows it only under defaults; lock-path comment matches
  lock-path.ts.
- **Notes**: Guards checked: tsconfig includes only src/, `pnpm lint` runs eslint without type
  information, and no test loads the example file, so the F6 change never surfaced the drift.

### [ ] T32. Per-repository `parallelism` is never validated (F9 fix only covered global/defaults): a non-positive-integer value passes load and makes every sync throw TypeError from p-limit

- **Category**: correctness · **Subsystem**: config
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/config-loader.service.ts:101-184` (`validateConfigFile repository loop
  (no parallelism check)`), `src/services/config-loader.service.ts:253-262`
  (`validateParallelismConfig call sites (global + defaults only)`),
  `src/services/config-loader.service.ts:681-686` (`resolveRepositoryConfig parallelism merge`),
  `src/services/worktree-mode-sync-runner.ts:120, 382, 418, 466, 517, 721, 795, 880`
  (`pLimit(this.config.parallelism?...)`), `sync-worktrees.config.example.js:131-135` (`documented
  per-repo parallelism override`), `REVIEW_FINDINGS.md:224-258` (`F9 (parallelism must be positive
  integers)`)
- **Current behavior**: validateParallelismConfig is invoked for `configObj.parallelism` and
  `defaults.parallelism` but not for `repositories[i].parallelism`, which the example config
  explicitly documents as a per-repo override. resolveRepositoryConfig merges the repo value
  verbatim. The runner calls pLimit() with the merged number at the start of each phase; p-limit
  7.3.1 throws `TypeError: Expected \`concurrency\` to be a number from 1 and up` for 0, negative,
  fractional, NaN or string values. The sync rejects on every tick (TypeError is not retryable),
  while `sync-worktrees list` and load report the config as valid. The safe-total-concurrency check
  (436-453) is likewise blind to per-repo overrides. Failure scenario: repositories: [{ name: 'big',
  repoUrl: ..., worktreeDir: './wt', parallelism: { maxStatusChecks: '50' } }] (string from a
  copy-paste, or `Number(process.env.STATUS_CHECKS)` = NaN, or 0/1.5). Load succeeds; `--runOnce`
  fails the repo with 'Expected `concurrency` to be a number from 1 and up' in the middle of the
  sync (after fetch), exit code 1, every run.
- **Expected behavior**: Call validateParallelismConfig(repoObj.parallelism, `Repository '${name}'`)
  inside the repository loop (same positive-safe-integer rule), and evaluate the total-concurrency
  guard against the effective merged per-repo limits (global/defaults maxRepositories × merged
  per-op limits).
- **Acceptance**: Loader tests: repository-level `parallelism: { maxStatusChecks: 0 }`, `'50'`,
  `1.5`, `NaN` each throw ConfigValidationError 'Repository 'x' parallelism.maxStatusChecks must be
  a positive integer'; a valid per-repo override still resolves and merges over defaults (existing
  tests at 1281-1347 keep passing); a per-repo override that pushes the total above
  MAX_SAFE_TOTAL_CONCURRENT_OPS is rejected with the existing message.
- **Notes**: Re-verified: the per-repository validation loop (config-loader.service.ts:96-190)
  validates retry, filesToCopyOnBranchCreate, hooks, sparseCheckout, maintenance, trash and depth,
  but never `repoObj.parallelism`; `resolveRepositoryConfig` (681-686) then merges it unvalidated.

### [ ] T33. `fetchTimeoutMs` / `cloneTimeoutMs` are documented on Config and promised by README but are silently dropped by resolveRepositoryConfig — no config-file user can change the 5/15-minute inactivity timeouts

- **Category**: workflow · **Subsystem**: config
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/config-loader.service.ts:612-723` (`resolveRepositoryConfig (explicit
  field allowlist)`), `src/types/index.ts:206-217` (`Config.fetchTimeoutMs / cloneTimeoutMs JSDoc
  ('Set 0 to disable')`), `src/services/git.service.ts:70-78`,
  `src/services/clone-sync.service.ts:99-105`, `README.md:621`,
  `src/types/__tests__/public-config-types.test.ts:33-34` (`InternalOnlyConfigKeys`)
- **Current behavior**: GitService and CloneSyncService read
  `config.fetchTimeoutMs`/`cloneTimeoutMs`, and the Config interface documents them as user knobs
  with defaults and 'Set 0 to disable'. resolveRepositoryConfig rebuilds the RepositoryConfig from
  an explicit list of fields and never copies these two (from repo or defaults), the validator
  ignores them, and the public SyncWorktreesConfig types omit them (classified 'internal'). README
  line 621 tells users that timeouts are tunable via the example config, which does not mention
  them. Result: setting `fetchTimeoutMs: 0` or `cloneTimeoutMs: 3600000` in any config file is a
  no-op with no warning. Failure scenario: A repo on a slow self-hosted server needs >5 min of
  silent server-side pack resolution (the same class of failure round-1 #30 describes for `fetch
  --unshallow`). The user adds `fetchTimeoutMs: 1800000` to the repository entry as the Config JSDoc
  suggests; every sync still aborts after 300 s with the simple-git timeout error, and nothing
  indicates the field was ignored.
- **Expected behavior**: Either (a) make the knobs real: validate as non-negative safe integers (0 =
  disabled) at repo and defaults level, propagate them in resolveRepositoryConfig, add them to
  SyncWorktreesCommonConfigFields and the example config; or (b) remove them from Config/JSDoc and
  fix README line 621 so it no longer claims timeouts are configurable. Option (a) is preferred
  given real-world slow remotes.
- **Acceptance**: Loader test: repo `{ fetchTimeoutMs: 0, cloneTimeoutMs: 60000 }` resolves with
  both fields present; `fetchTimeoutMs: -1` or `'abc'` throws ConfigValidationError; GitService
  built from the resolved config reports getFetchTimeoutMs()===0 (expose via a test seam) ;
  public-config-types.test.ts reclassifies the keys as common; README/example mention the fields.
- **Notes**: Re-verified: `resolveRepositoryConfig` (612-723) builds the resolved object field by
  field and never copies `fetchTimeoutMs` / `cloneTimeoutMs`.

### [ ] T34. `sync-worktrees init` reports success but writes configs that cannot be loaded: ESM syntax into a `.cjs` target or into a `"type": "commonjs"` package, and `worktreeDir: "./"` when the worktree dir equals the config dir

- **Category**: workflow · **Subsystem**: config
- **Severity**: Medium · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/utils/config-generator.ts:138-149` (`generateConfigFile (always emits `export
  default`)`), `src/utils/config-generator.ts:74-82` (`toConfigRelativePath (returns './' for equal
  dirs)`), `src/index.ts:303-330` (`runInit`), `src/services/config-loader.service.ts:56-67, 76-81`
  (`loadConfigFile (.cjs → require, else import; generic error wrap)`),
  `src/utils/interactive.ts:52-68` (`worktreeDir prompt`)
- **Current behavior**: runInit accepts any `--config` path and generateConfigFile always writes
  `export default config;`. If the target ends in `.cjs`, loadConfigFile uses require() and fails
  with 'Failed to load config file: Unexpected token 'export''. If the target is `.js` (the default)
  and the nearest package.json declares `"type": "commonjs"`, Node parses it as CJS and fails
  identically (Node's own stderr warning is the only hint). If the user answers the worktree-dir
  prompt with the config directory itself, the generator writes `worktreeDir: "./"`, and the default
  bareRepoDir `.bare/<name>` then lands inside worktreeDir, so the next run fails with
  'bareRepoDir/worktreeDir must not overlap'. In all three cases the wizard prints '✅ Configuration
  saved' and even offers MCP registration. Failure scenario: 1) `cd my-monorepo` (package.json has
  `"type": "commonjs"`), `sync-worktrees init`, answer prompts, then `sync-worktrees` → '❌ Error
  loading config file: Failed to load config file: Unexpected token 'export''. 2) `sync-worktrees
  init --config sync-worktrees.config.cjs` → same failure. 3) `sync-worktrees init`, worktree dir
  '.' → next run: 'must not overlap (bareRepoDir: .../.bare/repo, worktreeDir: ...)'.
- **Expected behavior**: generateConfigFile must emit CommonJS (`module.exports = config;`) when the
  target extension is `.cjs`, and when the target is `.js` and the nearest package.json has `"type":
  "commonjs"` it must either switch the default filename to `.mjs` or emit CJS. The wizard must
  reject a worktreeDir equal to the config directory for worktree mode (and warn for clone mode,
  where `git clone` into a non-empty dir fails). runInit should round-trip the generated file
  through ConfigLoaderService.loadConfigFile before printing success, and loadConfigFile should add
  a hint ('add "type": "module" or use .mjs/.cjs') when the SyntaxError is 'Unexpected token
  export'.
- **Acceptance**: config-generator tests: target `x.cjs` produces a file that loads via
  ConfigLoaderService; target `x.js` inside a temp dir whose package.json has type:commonjs loads
  (either because the generator wrote CJS or chose .mjs); worktreeDir === configDir for worktree
  mode is rejected by the wizard validate() with a message. index/runInit test: a generated config
  that fails to load makes init exit non-zero with the loader error instead of '✅ Configuration
  saved'.
- **Notes**: Guards checked: The generator round-trip test (config-generator.test.ts:294-318) only
  covers a `.js` target in a directory with no package.json, where Node's module-syntax detection
  rescues the file; there is no extension- or package-type-aware branch in the generator and no
  post-write load check in runInit.

### [ ] T35. Config hot-reload is stale for ESM configs that import sibling modules: only the top-level module is cache-busted, so TUI `r` and MCP `load_config` keep the first-loaded values of `./repos.js`-style imports

- **Category**: correctness · **Subsystem**: config
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/config-loader.service.ts:62-67` (`loadConfigFile ESM branch (?t=
  cache-buster on the config URL only)`), `src/services/config-loader.service.ts:265-288`
  (`clearRequireCacheSubtree (CJS-only child invalidation)`),
  `src/services/InteractiveUIService.tsx:275-276` (`handleReload → buildRepositories`),
  `src/mcp/context.ts:184` (`loadConfig`), `README.md:340`
- **Current behavior**: F9 fixed `.cjs` reload by deleting the require-cache subtree, and a test
  covers it. The ESM path appends `?t=<now>` to the config file URL only; modules the config imports
  with static `import` statements keep their original URL and stay in Node's ESM module map, so
  their evaluated exports are reused on every reload. README (line 340) advertises full Node module
  loading in config files. Failure scenario: sync-worktrees.config.mjs: `import { repos } from
  './repos.mjs'; export default { repositories: repos };`. Daemon is running; the user adds a
  repository to repos.mjs and presses `r`. The TUI logs 'Reloading configuration...' and re-syncs
  the OLD repository list; the new repo never appears until the process restarts. Same for MCP
  load_config in a long-lived server.
- **Expected behavior**: Reload must observe changes in transitively imported user modules.
  Practical spec: for ESM configs, spawn the import in a fresh context — e.g. evaluate the config in
  a child process (`node --input-type=module -e 'import(...)'` printing JSON) or use a dedicated
  `vm.SourceTextModule`/worker for loading; alternatively document that ESM child modules are not
  hot-reloaded and have load_config/`r` warn when the config file has ESM imports of relative
  modules. The child-process approach also isolates config-side effects from the daemon.
- **Acceptance**: New loader test mirroring the existing '.cjs' one
  (config-loader.service.test.ts:996-1021) but with `.mjs` config + `import` of a sibling `.mjs`:
  first load returns 'first', after rewriting the child the second load returns 'second'. The TUI
  reload path and MCP load_config are exercised through buildRepositories so they inherit the fix.
- **Notes**: ESM semantics: `import(file + '?t=' + Date.now())` re-evaluates only the top-level
  module; its static imports of sibling files are resolved by URL and stay cached for the process
  lifetime.

### [~] T36. Daemon/TUI mode never syncs at startup and no CLI/config option restores it: `--sync-on-start` was removed in 4.0.0 without a replacement, while README says the bare command 'starts syncing'

- **Category**: workflow · **Subsystem**: config
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/index.ts:179-205` (`runMultipleRepositories daemon branch (setupCronJobs
  only)`), `src/services/InteractiveUIService.tsx:166-183, 248-254` (`setupCronJobs /
  triggerInitialSync (only called from handleManualSync)`), `README.md:89, 92`, `CHANGELOG.md:167,
  184-191, 407-408, 891-893`
- **Current behavior**: The daemon branch constructs services, wires the TUI, schedules cron jobs
  and returns; nothing calls initialize() or triggerInitialSync(). With the default `0 * * * *`
  schedule the first sync (and, on a fresh machine, the initial bare clone) happens up to 59 minutes
  after launch unless the user presses `s`. History: initial sync was added in 3.x (CHANGELOG
  891-893), made opt-in via `--sync-on-start` (407-408), and 4.0.0 removed that flag (167) without
  listing a config replacement in its migration notes (184-191). README line 89 says
  `sync-worktrees` 'auto-loads the config ... and starts syncing'. Failure scenario: New user runs
  `sync-worktrees init` then `sync-worktrees` at 10:05 with the generated hourly schedule; the TUI
  shows '📋 1 repositories configured' and nothing else; no bare repo or worktree appears until
  11:00. A daemon restarted after a config change likewise waits a full cron period before applying
  it.
- **Expected behavior**: Add a `defaults.syncOnStart` (or per-repo) boolean, default true, and have
  runMultipleRepositories call `uiService.triggerInitialSync()` (non-blocking, after the UI is
  rendered) when enabled; document it in README and the 4.0.0 migration notes. Alternatively, keep
  no-startup-sync but change README line 89/92 to say syncing begins at the first cron tick or on
  `s`.
- **Acceptance**: index test with the mocked InteractiveUIService: daemon config →
  triggerInitialSync called once when syncOnStart is unset/true and not called when false; README
  documents the option; `sync-worktrees --help` output unchanged otherwise.
- **Notes**: Also reported by the TUI and process reviewers (`--sync-on-start` was removed in 4.0.0
  with no config replacement). Decide between syncing on start by default, a `defaults.syncOnStart`
  option, or documenting the wait; either way README line 89 must match. Also reported as:
  “Daemon/TUI mode never performs an initial sync and there is no config equivalent of the removed
  `--sync-on-start` flag: a headless daemon idles until the first cron tick (hourly by default)”.

### [ ] T37. create_worktree silently creates worktrees the next sync will move to trash: branches excluded by branchInclude/branchExclude/branchMaxAge, and push:false local-only branches (whose local branch ref is deleted too)

- **Category**: guardrail · **Subsystem**: mcp
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/mcp/handlers.ts:341-415` (`handleCreateWorktree`), `src/mcp/server.ts:263-289`
  (`create_worktree registration (push description)`), `src/services/worktree-sync-planner.ts:93-98`
  (`planPruneActions`), `src/services/worktree-mode-sync-runner.ts:268-330` (`resolveSyncBranches /
  filters`), `src/services/worktree-mode-sync-runner.ts:459-560` (`pruneOldWorktrees`),
  `src/services/trash.service.ts:318-369` (`trashAndUnregisterWorktree → deleteTrashedBranchRef`),
  `src/services/worktree-status.service.ts:228-282, 160-200` (`collectSnapshot / canRemove`)
- **Current behavior**: handleCreateWorktree never consults
  service.config.branchInclude/branchExclude/branchMaxAge, and offers push:false. The sync planner
  prunes every registered worktree whose branch is not in the FILTERED remote branch list
  (planPruneActions over plannedBranches from resolveSyncBranches). A freshly created worktree is
  clean, has no unpushed commits (rev-list <branch> --not --remotes = 0 because HEAD equals the base
  tip; sinceSync = 0 from the metadata written by addWorktree) and no 'upstream gone', so canRemove
  is true. Failure scenario: Config: {branchInclude:['main','release/*']} (documented feature) with
  the cron daemon running hourly. Agent: create_worktree {branchName:'feature/x'} (exists on origin)
  → success. Next daemon tick: feature/x is not in plannedBranches → check-prune → canRemove →
  trashAndUnregisterWorktree moves <worktreeDir>/feature-x-<hash> to .trash and deletes the local
  branch ref; the agent's next get_worktree_status/update_worktree fails ('not a registered
  worktree'). Same with create_worktree {branchName:'exp', baseBranch:'main', push:false}: the
  branch exists nowhere on origin, so the next sync trashes the worktree and deletes the local
  branch (recoverable only via trash restore, which the MCP surface does not expose). Uncommitted or
  unpushed work is protected by canRemove, but the checkout itself disappears.
- **Expected behavior**: create_worktree must (a) evaluate the branch against the selected repo's
  filters (filterBranchesByName(branchInclude, branchExclude) and, when branchMaxAge is set, the
  branch's activity) and refuse with a clear error ('feature/x is excluded by branchInclude [...];
  the next sync would remove this worktree — adjust the config or pass force:true') unless an
  explicit force flag is given; (b) for push:false (and for a failed push, success:false) include a
  `warning` field in the response stating that a local-only branch is pruned by the next sync until
  it is pushed, and say so in the push parameter description. Alternative larger fix: exclude
  local-only branches (no origin/<branch>) from prune in the planner.
- **Acceptance**: Handler tests: (1) service.config.branchInclude=['main'] + create_worktree
  feature/x → isError, message names the filter, git.addWorktree not called; with force:true
  proceeds. (2) branchMaxAge set + branch older than the window → same refusal (mock
  getRemoteBranchesWithActivity). (3) push:false → response.warning contains 'next sync' and
  createWorktreeOutputSchema gains warning?: string. (4) Tool description for push mentions the
  pruning consequence.
- **Notes**: Guards checked: The handler only validates the branch name (isValidGitBranchName) and
  the sanitized-path collision; branch filters live only in the sync runner. handlers.test.ts covers
  push:false only for the happy path (495-518). Round-1 #2 covers that push:false worktrees are
  never fast-forwarded, not that they are removed. README line 277 says removal only happens via
  sync's 'safety-gated pruning', which is exactly what triggers here.

### [ ] T38. sync tool reports success:true when the sync outcome recorded failures (counts.failed > 0); the CLI treats the same outcome as exit code 1

- **Category**: correctness · **Subsystem**: mcp
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/mcp/handlers.ts:417-459` (`handleSync`), `src/mcp/output-schemas.ts:180-217`
  (`syncOutputSchema`), `src/index.ts:118-127, 158-174` (`runOnce outcomeFailedNames →
  process.exitCode = 1`), `src/services/worktree-mode-sync-runner.ts:620-626`
  (`outcome.recordFailed('worktree', ..., {reason:'remove_failed'})`)
- **Current behavior**: handleSync returns `success: true` unconditionally once service.sync()
  resolves with started:true (lines 447-455). Per-worktree failures inside the runner are collected
  via Promise.allSettled and recorded as outcome actions of kind 'failed' (create/remove/update
  failures) without rejecting sync(). The CLI's runOnce path (index.ts:118-127) adds any repo with
  counts.failed > 0 to outcomeFailedNames and sets process.exitCode = 1 (line 172-174). Failure
  scenario: A worktree removal throws (e.g. EACCES on .trash) → runner records
  recordFailed('worktree', ..., remove_failed) and sync() resolves. MCP response: {success:true,
  duration, outcome:{counts:{failed:1,...}, actions:[{kind:'failed',...}]}, skips:[]}. An agent
  keying on `success` (the documented headline field: 'Returns: {success, duration, skips}') reports
  the sync as successful and moves on; the same run via `sync-worktrees --runOnce` exits 1.
- **Expected behavior**: success must be false whenever outcome.counts.failed > 0 (and the
  description should say so); optionally add top-level `failed: number` and `failures:
  actions.filter(kind==='failed')` so agents need not dig into actions. Keep isError false (the call
  itself succeeded).
- **Acceptance**: Handler test: service.sync resolves {started:true, outcome:{counts:{failed:1,...},
  actions:[{kind:'failed', scope:'worktree', error:'x', branch:'b'}]}} → body.success === false and
  body.failed === 1; existing 'calls service.sync and returns duration' test still passes with
  counts.failed 0 → success true. Tool description updated to 'success=false when any action
  failed'.
- **Notes**: Re-verified: `handleSync` (handlers.ts:447-455) returns `success: true`
  unconditionally; the CLI maps `counts.failed > 0` to exit code 1 (index.ts:126-133, 157-176).

### [~] T39. Tool input schemas are non-strict: unknown/misspelled arguments (repo_name, include_status, branch_name…) are silently stripped, so calls run against the wrong repo or with defaults instead of failing

- **Category**: workflow · **Subsystem**: mcp
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/mcp/server.ts:185-202, 219-227, 244-251, 268-278, 296-298, 316-319, 337-339,
  357-364, 382-384` (`inputSchema: z.object(...) for every tool`),
  `node_modules/@modelcontextprotocol/server/dist/mcp-DXXb3Vv3.mjs:1425-1431` (`validateToolInput
  (returns parseResult.data)`)
- **Current behavior**: All nine tools declare inputSchema with zod v4 `z.object`, which strips
  unknown keys. The SDK validates and passes parseResult.data to the handler, so an argument object
  with a misspelled key becomes `{}` (or loses that key) and the handler proceeds with defaults.
  Failure scenario: Multi-repo config, current repo = 'a'. Agent calls create_worktree
  {branch_name:'x', baseBranch:'main', repo_name:'b'} → zod strips branch_name and repo_name →
  branchName undefined → isValidGitBranchName crashes/rejects (ok), but create_worktree
  {branchName:'x', baseBranch:'main', repo_name:'b'} → repoName stripped → the branch and worktree
  are created in repo 'a' and the response says success. list_worktrees {repo_name:'b'} silently
  lists all repos; detect_context {include_status:true} silently returns no labels. Snake_case
  argument names are a common LLM failure mode.
- **Expected behavior**: Use z.strictObject (or .strict()) for every tool input so the SDK returns
  an InvalidParams error naming the unrecognized key(s); keep .optional() semantics otherwise.
- **Acceptance**: server.test.ts stdio test: tools/call create_worktree with arguments
  {branchName:'x', repo_name:'b'} → result.isError true and the message contains 'repo_name'; same
  for list_worktrees {repo_name}. All existing tool tests pass (they only use known keys).
- **Notes**: Guards checked: No test sends unknown keys; the SDK's validateToolInput relies entirely
  on the tool's schema strictness. Verified empirically with the project's zod: z.object({repoName,
  includeSize}).parse({repo_name:'x', include_size:true, includeSize:false}) → {"includeSize":false}
  (scratch t2.mjs).

### [ ] T40. create_worktree can move an unregistered directory at the target path into .trash (or rm -rf it when trash is disabled) although it is annotated destructiveHint:false and the README says the MCP surface cannot remove or touch trash

- **Category**: guardrail · **Subsystem**: mcp
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/mcp/handlers.ts:379-388` (`handleCreateWorktree → git.addWorktree`),
  `src/mcp/server.ts:280-286` (`create_worktree annotations destructiveHint:false`),
  `src/services/git.service.ts:566-580` (`addWorktree existing-dir branch`),
  `src/services/git.service.ts:978-1027` (`clearStaleWorktreeDirectory`), `README.md:277` (`Safety:
  'no removal or trash operations'`)
- **Current behavior**: handleCreateWorktree only checks the registered-worktree list for a path
  collision, then calls addWorktree. If <worktreeDir>/<sanitized> exists but is not a registered
  worktree (leftover from an interrupted removal/restore, a manual copy, or a directory the user
  parked there), addWorktree calls clearStaleWorktreeDirectory: with trash enabled it moves the
  directory into <worktreeDir>/.trash (reason 'orphan'); with trash disabled it quarantines it when
  it contains .git, otherwise `fs.rm -rf`. Failure scenario: Config trash.enabled=false. A previous
  prune failed after `git worktree remove` cleared the registration but before the directory was
  gone (or a user restored files into feature-x-<hash>/ by hand). Agent calls create_worktree
  {branchName:'feature/x'} → response success:true; the pre-existing directory content (no .git) was
  permanently deleted by a tool advertised as non-destructive. With trash enabled the content is
  recoverable only through the CLI/TUI trash flows the agent cannot see.
- **Expected behavior**: In the MCP handler, stat the computed worktreePath before addWorktree: if
  it exists and is not in git.getWorktrees()/includeDetached list, refuse with 'path exists but is
  not a registered worktree; remove it manually or run sync' (no trash/rm from the MCP path).
  Alternatively keep the behavior but set destructiveHint:true and document it in the tool
  description and README.
- **Acceptance**: Handler test: fs.stat of the target path resolves (mock) and getWorktrees does not
  contain it → create_worktree returns an error and git.addWorktree is not called. README Safety
  bullet updated accordingly.
- **Notes**: Contradicts the README 'Safety' section (the MCP surface exposes no removal or trash
  operations): `addWorktree` → `clearStaleWorktreeDirectory` (git.service.ts:566-579, 978-1026)
  moves an unregistered directory at the target path into trash, or `rm -rf`s it when trash is
  disabled.

### [ ] T41. Concurrent sync cycles share one TUI status flag: the first cycle to finish (cron group, overlapping tick, or a fail-fast skip) flips the UI to idle, wipes the running cycle's progress rows and re-enables the `s`/`x`/`r` guards

- **Category**: correctness · **Subsystem**: tui
- **Severity**: Medium · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/services/InteractiveUIService.tsx:931-963`
  (`InteractiveUIService.runSyncCycle`), `src/services/InteractiveUIService.tsx:984-1002, 1020-1021`
  (`InteractiveUIService.runSyncServices`), `src/services/InteractiveUIService.tsx:166-186`
  (`InteractiveUIService.setupCronJobs`), `src/components/App.tsx:171-193, 203-226` (`App useInput /
  setStatus / setSyncProgress listeners`), `src/components/StatusBar.tsx:328-340`
- **Current behavior**: `runSyncCycle` emits `setStatus("syncing")` on entry and unconditionally
  `setStatus("idle")` in its `finally` (which App turns into `setSyncProgressEntries([])`).
  `setupCronJobs` creates one cron task per distinct schedule, so two repos on different schedules
  run as independent cycles; node-cron also fires the next tick while a long sync is still running,
  and the manual `s` key starts a third kind of cycle. `runSyncServices` additionally emits a
  `{completed:true}` progress event for every repo in its `finally`, even when `service.sync()`
  returned `{started:false, reason:"in_progress"}` immediately because another cycle owns that repo.
  App's `s`, `x` and `r` handlers only check the boolean `status`. Failure scenario: Config:
  `frontend` on `*/30 * * * *`, `backend` on `0 * * * *`. At the top of the hour both groups fire;
  `backend` finishes in 5 s while `frontend` fetches for 2 minutes. Backend's cycle runs
  `setStatus("idle")` → status bar shows `✓ Running`, progress rows disappear (StatusBar only
  renders progress while `status === "syncing"`), `s` becomes enabled again and pressing it launches
  another cycle that fail-fasts for `frontend` (`Sync skipped for 'frontend': sync skipped:
  in_progress` warning) and, via the `completed` event, removes frontend's live progress row a
  second time; `x` (force clean) is likewise openable while a sync is running although the code
  guards it with `status !== "syncing"`. Same outcome with a single repo whenever a cron tick
  overlaps a running sync (verified in a scratch test: second cycle emitted `completed` for the repo
  and `setStatus=idle` at 101 ms while the first cycle ran until 603 ms).
- **Expected behavior**: Track active cycles with a counter (or a Set of cycle ids) in
  InteractiveUIService; emit `setStatus("syncing")` when the count goes 0→1 and `setStatus("idle")`
  only when it returns to 0. Do not emit a `completed` progress event for a repo whose `sync()`
  returned `started:false` (another cycle owns that row). App guards for `s`/`x`/`r` keep working
  off the derived status.
- **Acceptance**: Unit test (interactive-ui.service.test.ts): start `triggerInitialSync()` with a
  service whose first `sync()` resolves after 500 ms, then call the cron path (`runSyncCycle`) with
  the same service returning `{started:false, reason:"in_progress"}`; assert no `setStatus("idle")`
  and no `{completed:true}` progress event is emitted before the first sync resolves, and exactly
  one `idle` after. App test: while a `setSyncProgress` row for repo A is live, an `in_progress`
  skip for A must not remove it.
- **Notes**: Also reported by the process reviewer: node-cron schedules with `noOverlap` unset, so a
  slow sync plus a manual `s` or a second cron group produces two concurrent `runSyncCycle` calls
  that share one status flag. Also reported as: “Overlapping cron tick or manual `s` during a long
  sync flips the TUI status to idle and clears the progress panel while the first sync is still
  running (node-cron default noOverlap=false; fail-fast skip finishes instantly)”.

### [ ] T42. Ctrl+C in the TUI unmounts Ink (default `exitOnCtrlC`) but never runs `destroy()`: the process keeps running headless with cron syncs, log events go nowhere, and a second Ctrl+C then kills it mid-sync

- **Category**: guardrail · **Subsystem**: tui
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/InteractiveUIService.tsx:199-246` (`InteractiveUIService.renderUI
  (render options)`), `src/services/InteractiveUIService.tsx:362-365, 1102-1130` (`handleQuit /
  destroy`), `src/services/InteractiveUIService.tsx:150-157` (`addLog`), `src/index.ts:180-190`,
  `node_modules/ink/build/components/App.js:141-155` (`handleInput (exitOnCtrlC → handleExit →
  onExit)`)
- **Current behavior**: `render(<App/>, { alternateScreen: true, incrementalRendering: true })`
  leaves Ink's default `exitOnCtrlC: true`. While Ink holds stdin in raw mode, Ctrl+C is delivered
  as `\x03` to Ink, which disables raw mode and unmounts the React tree; it does not call
  `process.exit`, `onQuit`, or the service's `destroy()`. `waitUntilExit()` is never awaited by the
  service. Node-cron tasks created in `setupCronJobs` keep the event loop alive, so the process
  continues as a headless daemon: `addLog` still emits `addLog` events but App's listeners were
  removed on unmount, so every subsequent log line (including sync errors) is dropped. Because raw
  mode is now off, a second Ctrl+C produces SIGINT, which `setupSignalHandlers` turns into
  `uiService.destroy(true)` (2 s wait) and `exit(0)`. Failure scenario: User runs `sync-worktrees`
  (TUI), presses Ctrl+C. The alternate screen is left, the shell scrollback reappears but no prompt
  returns; the user assumes the tool exited or hung. On the next cron tick a sync starts silently
  (fetch, worktree add/prune, trash moves) with no visible log. The user presses Ctrl+C again →
  `destroy(fast=true)` waits ≤2 s then `process.exit(0)` kills git mid-operation (a half-created
  worktree directory that the next sync must treat as orphan/stale). Verified: after `\x03`, Ink's
  `waitUntilExit()` resolved, `onQuit` was never called, and an `addLog` emitted afterwards was
  never rendered.
- **Expected behavior**: Pass `exitOnCtrlC: false` and handle Ctrl+C inside the app's `useInput`
  (`input === "c" && key.ctrl` → same path as `q`), or await `instance.waitUntilExit()` in
  InteractiveUIService and run `destroy()` + `process.exit` when it resolves. Either way Ctrl+C must
  behave like `q`: cancel cron jobs, wait for in-flight syncs (with the fast/slow timeout policy),
  unmount, exit.
- **Acceptance**: Test rendering App through Ink with a fake TTY stdin (as in the scratch test):
  writing `\x03` must invoke `onQuit` exactly once (or resolve a promise that the service turns into
  `destroy()`); `cronJobs` must be stopped; no `addLog` event may be emitted into an unmounted tree.
  Manual: `sync-worktrees` → Ctrl+C returns to the shell prompt with exit code 0 (or 130), no
  lingering process (`pgrep -f sync-worktrees` empty).
- **Notes**: Also reported by the process reviewer. Ink's default `exitOnCtrlC` unmounts the app on
  Ctrl+C without invoking the SIGINT handler chain registered in index.ts, so `destroy()` (cron
  stop, lock release, waiting for in-flight syncs) never runs. Re-verified: `render()` in `renderUI`
  (InteractiveUIService.tsx:199-246) passes no `exitOnCtrlC: false`, and only `handleQuit` (the `q`
  key) calls `destroy()` then `process.exit(0)` (362-365). Also reported as: “Ctrl+C in the TUI
  tears down Ink but leaves the daemon running headless: cron keeps firing, logs are dropped, `q` is
  dead, until a second Ctrl+C (README also claims Esc quits, which is not implemented)”.

### [ ] T43. `MOUSE_TRACKING_DISABLE` is never written on any exit path (q, SIGTERM, Ctrl+C): Ink marks itself unmounted before React effect cleanups run, so `useStdout().write` in App's cleanup is a no-op and the shell inherits a terminal with mouse reporting on

- **Category**: correctness · **Subsystem**: tui
- **Severity**: Medium · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/components/App.tsx:117-122` (`mouse tracking useEffect`),
  `src/services/InteractiveUIService.tsx:1113-1116` (`destroy → app.unmount()`),
  `src/utils/mouse.ts:9-10`, `node_modules/ink/build/ink.js:433-436, 516-518, 604-615`
  (`writeToStdout / unmount ordering`)
- **Current behavior**: App enables mouse reporting with `write(MOUSE_TRACKING_ENABLE)` in an effect
  and relies on the effect cleanup `write(MOUSE_TRACKING_DISABLE)` on unmount. Ink 7's `unmount()`
  sets `this.isUnmounted = true` (ink.js:518) before `reconciler.updateContainerSync(null, ...)`
  tears the tree down (ink.js:604-615), and `writeToStdout` returns early when `isUnmounted`
  (ink.js:433-436). The disable sequence is therefore discarded on every exit path; only Ink's own
  alternate-screen exit and cursor-show are written. Failure scenario: User presses `q` (or the
  process receives SIGTERM, or Ctrl+C per the previous finding). The TUI exits, but the terminal
  still has DECSET 1000/1006 active: every click or wheel movement in the shell types
  `[<0;12;7M`-style garbage into the prompt until the user runs `reset`. This is exactly the symptom
  the code comment at App.tsx:115-116 says the cleanup exists to prevent. Verified with a fake TTY
  stdout: after `instance.unmount()` the frames contain `\x1b[?1049l` (exit alt screen) but never
  `\x1b[?1006l\x1b[?1000l`.
- **Expected behavior**: Write the disable sequence outside React's lifecycle: in
  `InteractiveUIService.destroy()` write `MOUSE_TRACKING_DISABLE` directly to `process.stdout` after
  `this.app.unmount()` (and once more in the signal handler / `beforeExit` for safety), or
  enable/disable tracking in the service rather than in a component effect. Keep the enable in place
  (or move it next to the disable so both live in one owner).
- **Acceptance**: Test: render App through `ink.render` with a fake TTY stdout, call `unmount()`
  (and separately the Ctrl+C path once fixed), and assert the written stream contains
  `MOUSE_TRACKING_DISABLE` after the last frame and after `\x1b[?1049l`. Manual: after quitting the
  TUI, clicking in the shell must not insert escape sequences.
- **Notes**: Guards checked: The pairing test in mouse.test.ts (`pairs enable and disable so the
  terminal is left as it was found`) only checks the constant strings; nothing verifies the disable
  reaches stdout. Ink has no built-in mouse mode management to fall back on (grep of ink/build for
  `1000h`/`useMouse` finds none).

### [ ] T44. Branch wizard acts on stale refs and its collision check is decorative: it submits the unsuffixed name, `createBranch` only detects local heads, `push -u` can silently fast-forward an existing remote branch, and a failed push leaves an orphan local branch that makes the next attempt create `<name>-1`

- **Category**: guardrail · **Subsystem**: tui
- **Severity**: Medium · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/components/BranchCreationWizard.tsx:109-137, 152-183, 402-431`
  (`checkBranchExists / handleCreateBranch / renderNameInput`),
  `src/services/InteractiveUIService.tsx:545-591` (`InteractiveUIService.createAndPushBranch`),
  `src/services/InteractiveUIService.tsx:492-509, 521-543` (`getBranchesForRepo / fetchForRepo
  (fetch only when list is empty)`), `src/services/git.service.ts:1471-1484`
  (`GitService.createBranch / pushBranch`)
- **Current behavior**: The wizard's branch list comes from `git branch -r` as of the last
  sync/fetch; `fetchForRepo` is only invoked when that list is empty. `checkBranchExists` displays
  `Name exists, will create: <name>-N` based on that list, but `handleCreateBranch` submits
  `trimmedName` (the unsuffixed name). `createAndPushBranch` runs `git branch --no-track <name>
  origin/<base>` and only appends a suffix when git says `already exists` (a *local* head). If no
  local head exists (branch filtered out by `branchMaxAge`/`branchInclude`/`branchExclude`, or
  pushed by a teammate after the last fetch), creation succeeds and `git push origin <name>:<name>
  -u` runs without any lease: when the remote branch tip is an ancestor of the base, the push
  fast-forwards the existing remote branch; otherwise it is rejected and the freshly created local
  branch is left behind (no rollback), so the next attempt with the same name hits `already exists`
  and silently produces `<name>-1`. Failure scenario: (1) Config has `branchMaxAge: "30d"`; a
  45-day-old merged branch `hotfix` still exists on origin (no worktree, no local head). User
  creates `hotfix` in the wizard; UI says `will create: hotfix-1`; service creates local `hotfix`
  from `origin/main` and pushes → remote `hotfix` is moved from its old commit to main's tip
  (verified: `c9597a7..793529a later -> later`, exit 0) and the wizard reports `Created: hotfix`.
  Any open PR or CI job on that branch now points at main's history. (2) Teammate pushed `feature/x`
  with commits 20 minutes ago; hourly cron has not fetched it; user creates `feature/x` → push
  rejected `non-fast-forward`, error shown, local `feature/x` (at main's tip) remains in the bare
  repo; user retries → `already exists` → wizard creates and pushes `feature/x-1` from main, never
  telling the user the original name collided remotely.
- **Expected behavior**: Before creating: fetch the target ref (`fetchBranch(name)` tolerant of
  missing ref, or `ls-remote --exit-code origin refs/heads/<name>`) and treat an existing remote ref
  as a collision (apply the same suffix logic). Push with `--force-with-lease=refs/heads/<name>:`
  (empty expectation = remote ref must not exist) so an unexpectedly existing remote branch is never
  advanced. On push failure, delete the local branch created in this attempt (`git branch -D
  <name>`) before returning the error. Make the wizard submit exactly the name it displayed (or have
  the service return the final name and the wizard display only that).
- **Acceptance**: git.service/interactive-ui tests: (a) remote-only `origin/x` (no local head) →
  `createAndPushBranch("x")` returns `finalName: "x-1"` (or refuses) and never pushes to
  `refs/heads/x`; (b) push rejected → `show-ref refs/heads/x` is absent afterwards and the returned
  error names the push failure; (c) `pushBranch` invokes git with
  `--force-with-lease=refs/heads/<name>:`; (d) wizard test: with `branches=["x"]`, typing `x` and
  pressing Enter calls `createAndPushBranch` with `"x-1"` (or the service-returned name is what is
  displayed). Integration test on a local bare remote reproducing scenario (1) must leave the remote
  `hotfix` tip unchanged.
- **Notes**: Also reported by the process reviewer as the missing rollback in `createAndPushBranch`
  (InteractiveUIService.tsx:559-581): delete the local branch when `pushBranch` fails, and fetch
  before checking existence so the suggested suffix reflects the remote. Also reported as:
  “createAndPushBranch has no rollback: when `git branch` succeeds and the push fails, the local
  branch stays in the bare repo, so the next attempt with the same name is diverted to `<name>-1`
  while `<name>` is never pushed”.

### [ ] T45. OpenEditorWizard and WorktreeStatusView re-run their loader forever when it returns an empty list (no `loaded` guard), spinning React renders and git/fs calls while the modal is open

- **Category**: performance · **Subsystem**: tui
- **Severity**: Medium · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/components/OpenEditorWizard.tsx:53-73` (`loadWorktrees + useEffect`),
  `src/components/WorktreeStatusView.tsx:205-225, 260-264` (`loadStatus + useEffect`),
  `src/components/BranchCreationWizard.tsx:54, 139-144` (`branchesLoadedRef (the guard the other two
  lack)`), `src/services/clone-sync.service.ts:77-91` (`CloneSyncService.getWorktrees (returns []
  before init)`), `src/services/InteractiveUIService.tsx:602-621` (`getWorktreeStatusForRepo (drops
  rejected entries → [])`), `src/index.ts:180-205`
- **Current behavior**: Both effects re-trigger the loader whenever `entries.length === 0 &&
  !loading`. With any real (asynchronous) loader, `setLoading(true)` commits, then the result
  commits `loading=false` with length still 0, so the effect fires again — a render/loader loop for
  as long as the modal is open. BranchCreationWizard avoids this with `branchesLoadedRef`. Failure
  scenario: Clone-mode repo in a fresh workspace: the TUI does not sync on start (index.ts daemon
  branch never triggers a sync; first cron tick may be an hour away), so `<worktreeDir>/.git` does
  not exist and `getWorktrees()` returns `[]`. User presses `o` or `w` → the modal shows `No
  worktrees found` while calling `getWorktreesForRepo`/`getWorktreeStatusForRepo` back-to-back (each
  doing `fileExists` + git spawns + `readdir` of `.diverged`), pegging a CPU core and re-rendering
  continuously until ESC. Same for a worktree-mode repo whose every status probe rejects (allSettled
  filter yields `[]`). Measured: 20 loader invocations in 500 ms with a 20 ms loader — i.e. one call
  per loader round-trip, unbounded.
- **Expected behavior**: Track load completion per selected repo (a `loadedRef`/`loadedForRepoIndex`
  like BranchCreationWizard) and only load once per selection; reset on ESC back to project
  selection. Show `No worktrees found` as a terminal state.
- **Acceptance**: Component tests: with `getWorktreesForRepo`/`getWorktreeStatusForRepo` implemented
  as `async () => { await delay(20); return []; }`, after 500 ms the mock must have been called
  exactly once and the frame shows `No worktrees found`; selecting another repo (multi-repo) loads
  once more.
- **Notes**: Also reported by the process reviewer with a measured rate of roughly 40 loader calls
  per second for a repo with zero worktrees. Also reported as: “OpenEditorWizard re-runs
  getWorktreesForRepo in a tight loop (≈40 calls/s, each a `git worktree list` in worktree mode)
  whenever the selected repo has zero worktrees”.

### [ ] T46. LogPanel exceeds its height budget by 1-2 rows in the steady state (plus one row per embedded newline), so the App frame is taller than the terminal and Ink falls back to a full-terminal clear on every render, scrolling the top row off

- **Category**: performance · **Subsystem**: tui
- **Severity**: Medium · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/components/LogPanel.tsx:52-55, 141-147, 162-166, 168-172, 178-182`
  (`visibleLines budget / indicator rows / wrap="truncate"`), `src/components/App.tsx:249-257`
  (`logPanelHeight / minHeight={terminalRows}`), `src/services/worktree-sync.service.ts:495, 519,
  523, 527-531` (`log messages containing "\n" / logger.table`),
  `node_modules/ink/build/ink.js:89-112, 748-777` (`shouldClearTerminalForFrame /
  renderInteractiveFrame`)
- **Current behavior**: `visibleLines = height - 2 (border) - 1 (header)` but the `↑ N more above` /
  `↓ N more below` rows are rendered in addition, and a multi-line message renders as multiple rows
  (`wrap="truncate"` does not collapse `\n`). Once more entries exist than fit (true after the first
  sync or two), follow mode renders `height + 1` rows, a parked scroll position renders `height +
  2`; every sync also logs `Synchronization finished.\n` (2 rows) and, with `debug: true`, the
  timing table (~8 rows) as one entry. App sizes the column to `terminalRows`, so the frame becomes
  `terminalRows + 1..N`. Ink treats `outputHeight > viewportRows` as overflow and re-renders with
  `clearTerminal + full frame` on every subsequent render (defeating `incrementalRendering`), and
  the first row (LogPanel's top border) scrolls off. Failure scenario: Any TUI session after ~20 log
  lines in a 24-row terminal: each new log line (git progress bucket, hook stdout, per-branch
  messages) clears and repaints the whole screen → visible flicker, and the top border/`📋 Logs (N
  entries)` header is pushed out of view. With `debug: true` the performance table entry alone adds
  8 rows. Measured in a 10-row panel: 40 entries in follow mode → 11 rows; parked → 12 rows; a
  `...finished.\n` entry → 11 rows; a 6-line table entry → 16 rows.
- **Expected behavior**: Budget the indicator rows inside `height` (`visibleLines = height - 3 -
  (hasMoreAbove ? 1 : 0) - (hasMoreBelow ? 1 : 0)`, computed iteratively or by reserving both rows),
  normalize messages to single lines at `addLog` (split on `\n` into separate entries, or replace
  with ` ⏎ `), and give the panel's outer Box a fixed `height` with `overflow="hidden"` so the total
  never exceeds `terminalRows`.
- **Acceptance**: LogPanel test: for `height=10` and 40 entries, `lastFrame().split("\n").length ===
  10` in follow mode, after two wheel-ups (parked), and with an entry containing `\n`. App test with
  `LINES=24`: after 100 `addLog` events the frame has exactly 24 lines and still contains the `s`ync
  … `q`uit hint row and the `📋 Logs` header.
- **Notes**: Guards checked: LogPanel.test.tsx asserts content (`more above`, `(auto)`), never row
  counts; App.test.tsx does not measure frame height. The 5.2.0 changelog entry fixed scroll-offset
  clamping, not the height budget.

### [ ] T47. Cross-process repo lock is keyed on XDG_STATE_HOME/HOME, so a daemon and a shell-launched run can hold different lock files for the same worktreeDir (clone mode then has no lock at all); lock also lives under ~/.cache

- **Category**: guardrail · **Subsystem**: process
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/utils/lock-path.ts:48-57` (`getWorktreeDirLockTarget`),
  `src/services/repo-operation-lock.ts:34-54` (`acquire / acquireWorktreeDirLock`)
- **Current behavior**: getWorktreeDirLockTarget canonicalizes worktreeDir through symlinks (lines
  151-165, the 5.3.1 fix) but then places the lock file under `process.env.XDG_STATE_HOME` when set,
  otherwise `os.homedir()/.cache` (177-181). The lock key therefore depends on two environment
  variables that routinely differ between the processes the lock is meant to serialize: an
  interactive shell (dotfiles export XDG_STATE_HOME=~/.local/state, which is the XDG default value)
  versus a systemd/launchd/cron-started daemon (minimal env, no XDG_STATE_HOME), or `sudo -E` vs
  plain sudo (different HOME). Clone mode holds ONLY this lock (repo-operation-lock.ts:34-36);
  worktree mode additionally locks the bare path (58-63), which still covers the common same-config
  case but not two configs with distinct bareRepoDirs sharing a worktreeDir (the exact case the
  5.3.1 comment at 66-70 says the worktreeDir lock exists for). In addition `~/.cache` is by XDG
  definition disposable; cache cleaners (`rm -rf ~/.cache`, systemd-tmpfiles age rules, macOS 'clear
  caches') can delete the lock directory under a live holder, after which proper-lockfile's refresh
  reports ECOMPROMISED and `onCompromised` (104-109) deliberately continues while a second process
  can acquire. Failure scenario: Clone-mode repo `app` with worktreeDir /srv/app, synced by a
  systemd user service (env without XDG_STATE_HOME → lock at
  ~/.cache/sync-worktrees/locks/<hash>.lock). The user opens a terminal whose profile exports
  XDG_STATE_HOME=$HOME/.local/state and runs `sync-worktrees --runOnce` while the daemon tick is mid
  ff-merge (or mid `fetch --unshallow`). The second process computes
  ~/.local/state/sync-worktrees/locks/<hash>.lock, finds it free, acquires it, and runs
  configureSingleBranchRemote / delete stale remote refs / merge concurrently in the same checkout —
  the race the lock was added to prevent (CHANGELOG 5.3.1 'serialize worktree-mode syncs on the
  worktreeDir').
- **Expected behavior**: The lock location must be a pure function of the canonical worktreeDir (and
  nothing else in the environment). Options: (a) put the lock file at a fixed location derived only
  from the canonical worktreeDir's parent directory (e.g. `<canonical
  parent>/.sync-worktrees-<hash>.lock`, never inside the checkout), or (b) if a home-relative dir is
  kept, use one fixed base (`~/.local/state/sync-worktrees/locks`) resolved from `os.homedir()` only
  and ignore XDG_STATE_HOME, and document that the same user must run all instances. Whatever is
  chosen, do not use `~/.cache`.
- **Acceptance**: Unit test: getWorktreeDirLockTarget(config) returns the identical {dir,file} with
  XDG_STATE_HOME unset, set to ~/.local/state, and set to an arbitrary directory. Integration test
  (real proper-lockfile, NODE_ENV not 'test'): process A acquires the lock for /tmp/wt with
  XDG_STATE_HOME unset; process B with XDG_STATE_HOME=/tmp/x calling RepoOperationLock.acquire() for
  the same worktreeDir returns null. Existing lock-path tests (symlink canonicalization) keep
  passing.
- **Notes**: Re-verified (locations corrected — the file is 78 lines): `getWorktreeDirLockTarget`
  keys the lock file by a hash of the canonical worktreeDir but places it under
  `$XDG_STATE_HOME/sync-worktrees/locks` or `~/.cache/sync-worktrees/locks` (lock-path.ts:48-57).
  Two processes with different `HOME`/`XDG_STATE_HOME` (a launchd/systemd daemon vs. an interactive
  shell, or `sudo`) therefore lock different files. Clone mode holds only this lock
  (repo-operation-lock.ts:34-36). Consider a lock inside the state directory of the config file
  (already used for the audit log) or next to the target directory, and use `~/.local/state` rather
  than `~/.cache` for the fallback.

### [~] T48. Docs drift: README says hooks/file copy run for every newly created worktree and that copy globs resolve relative to the config directory; in code both fire only from the TUI branch wizard, and the TUI copies from the base-branch worktree (clone mode: config dir) — sync- and MCP-created worktrees never get either

- **Category**: docs · **Subsystem**: process
- **Severity**: Medium · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `README.md:616-619`, `src/services/InteractiveUIService.tsx:1071-1100`
  (`copyBranchFiles`), `src/services/InteractiveUIService.tsx:1051-1069`
  (`executeOnBranchCreatedHooks`), `src/services/clone-sync.service.ts:805-833`
  (`runInitialFileCopy`), `src/components/App.tsx:269-302`, `sync-worktrees.config.example.js:254,
  291-295`, `CHANGELOG.md:403`
- **Current behavior**: README 616: 'hooks.onBranchCreated — array of shell commands run after a new
  branch's worktree is created'; 617: 'filesToCopyOnBranchCreate — paths copied into every newly
  created worktree … Glob patterns are resolved relative to the config file's directory.' Reality:
  (1) the only callers of copyFiles/runHooks are the TUI wizard (App.tsx:269-302 →
  InteractiveUIService copyBranchFiles/executeOnBranchCreatedHooks) and the clone-mode initial copy
  (clone-sync.service.ts:817). The worktree-mode sync runner's create phase and MCP create_worktree
  call neither (grep across src: no other call sites). (2) In the TUI path sourceDir is the *base
  branch's worktree* (1097: `sourceDir: sourceWorktree.path`), matching CHANGELOG 403 ('copy from
  the base branch'), while clone mode uses `__configFileDir` (817). The example config (254,
  291-295) describes the TUI-only scope correctly; README does not. Failure scenario: User reads
  README, sets `filesToCopyOnBranchCreate: ['.env.local']` keeping .env.local next to the config
  file, expecting every worktree the hourly sync creates to receive it. Nothing is ever copied (sync
  creation does not call copyFiles), and even from the TUI wizard the file is looked up in the
  base-branch worktree, where a gitignored .env.local usually does not exist, so the copy logs
  nothing (BranchCreatedActionsService only logs when copied>0 or errors>0).
- **Expected behavior**: Either implement the README contract (run copy+hooks in the worktree-mode
  create phase and MCP create_worktree, with sourceDir = config dir) or correct README 616-619 to
  state: TUI branch-wizard only; source directory = base-branch worktree in worktree mode, config
  directory in clone mode. Log an info line when a copy pass matches zero files so the
  misconfiguration is visible.
- **Acceptance**: README paragraph rewritten (or feature implemented with runner tests asserting
  copyFiles/hook invocation after addWorktree). BranchCreatedActionsService.copyFiles logs 'matched
  0 files for patterns […] in <sourceDir>' when copied/skipped/errors are all empty.
- **Notes**: Product decision: README (`Hooks and file copying`) promises both for every newly
  created worktree; today only the TUI branch wizard (and clone-mode initial clone for file copy)
  trigger them, so worktrees created by sync or by the MCP `create_worktree` tool get neither.
  Either wire `BranchCreatedActionsService` into `createNewWorktrees`/`handleCreateWorktree` (hooks
  are fire-and-forget, so the daemon would spawn user commands unattended) or narrow the README to
  TUI-created branches.

### [ ] T49. Git subprocesses never set GIT_TERMINAL_PROMPT=0 (or SSH BatchMode): in the TUI a credential prompt is written into the alternate screen and the fetch blocks until the 300 s inactivity timeout instead of failing immediately with an actionable message

- **Category**: workflow · **Subsystem**: process
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/utils/git-env.ts:9-15` (`sanitizeGitEnv`), `src/services/git.service.ts:80-105`
  (`getCachedGit / buildSimpleGitOptions`), `src/services/clone-sync.service.ts:184-190`,
  `src/constants.ts:57` (`FETCH_TIMEOUT_MS`)
- **Current behavior**: All git clients inherit the parent environment (sanitizeGitEnv only strips
  EDITOR variables). git prompts for credentials on /dev/tty whenever a terminal is attached and
  GIT_TERMINAL_PROMPT is unset, regardless of stdio pipes. In the TUI the terminal is attached (raw
  mode, alternate screen), so an HTTPS remote without a working credential helper, or an SSH key
  with a passphrase and no agent, makes `git fetch` print 'Username for …:' into the Ink frame and
  wait; keystrokes go to Ink, so the prompt is never answered and the operation only ends when
  simple-git's block timeout (fetchTimeoutMs, 300 s) kills it, after which the sync retry policy
  retries (up to 3 attempts → 15 minutes per tick) with the same result. Failure scenario: macOS
  user whose keychain token expired (or Linux user with no credential.helper): the hourly sync in
  the TUI shows a corrupted frame containing 'Username for https://github.com:', the progress line
  freezes for 5 minutes, then '⚠️ Sync attempt 1 failed: … timeout' and two more 5-minute attempts.
  With GIT_TERMINAL_PROMPT=0 git fails within a second with 'could not read Username … terminal
  prompts disabled', which is the message the user needs.
- **Expected behavior**: Set `GIT_TERMINAL_PROMPT: '0'` (and consider `GIT_SSH_COMMAND` defaulting
  to `ssh -o BatchMode=yes` only when the user has not set GIT_SSH_COMMAND) in the environment of
  every non-interactive git subprocess (sanitizeGitEnv is the natural place; the default simple-git
  clients that do not call .env() must also get it — e.g. via `git -c` is not possible for this
  variable, so pass an explicit env to every client). Surface the resulting 'terminal prompts
  disabled' error with a hint about configuring a credential helper.
- **Acceptance**: Unit test that sanitizeGitEnv output contains GIT_TERMINAL_PROMPT='0' and
  preserves an existing user value; test that the default (non-LFS) client built by getCachedGit
  passes an env containing it. Manual check: fetch from an HTTPS URL requiring auth without a helper
  fails within seconds in the TUI with a readable log line.
- **Notes**: Not set anywhere in src (grep for `GIT_TERMINAL_PROMPT` / `BatchMode` is empty).
  Setting `GIT_TERMINAL_PROMPT=0` (and `GIT_SSH_COMMAND` with `-o BatchMode=yes` only when the user
  has not set one) in `sanitizeGitEnv` turns a silent 5-minute hang per tick into an immediate,
  actionable authentication error.

### [ ] T50. Repository URLs are echoed verbatim in logs, the `list` command, error messages and MCP responses, so a `https://user:TOKEN@host/repo.git` credential leaks into terminal scrollback, TUI log buffers and agent transcripts

- **Category**: guardrail · **Subsystem**: security
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/index.ts:67` (`runMultipleRepositories (URL: ...)`),
  `src/services/git.service.ts:120` (`GitService.initialize (Cloning from ...)`),
  `src/services/clone-sync.service.ts:636, 700-717` (`initializeInternal / evaluateOriginMatch`),
  `src/mcp/context.ts:593-600` (`DiscoveredRepoContext.repoUrl`),
  `src/services/hook-execution.service.ts:66-74` (`buildEnvironment (SYNC_WORKTREES_REPO_URL)`)
- **Current behavior**: The README's example config shows `repoUrl: process.env.WORK_REPO_URL ||
  ...` for 'sensitive data', and HTTPS URLs with embedded tokens are the common way to do that in
  CI. Nothing redacts the userinfo part: the run-once banner prints `URL: <repoUrl>`, clone/init
  messages print it, origin-mismatch warnings print both the actual and expected URL,
  `detect_context`/`list_worktrees` return `repoUrl` read from `git remote get-url origin` to the
  MCP client, and git's own error text (which includes the URL for 'could not read from remote') is
  passed through `getErrorMessage` into logs and MCP error responses. Failure scenario: A CI job
  runs `sync-worktrees --runOnce` with a token URL; the token appears in the CI log. An AI agent
  calls `detect_context` in a workspace whose remote was cloned with a token URL; the token is now
  in the agent's transcript and any tool-call logging.
- **Expected behavior**: Add a `redactRepoUrl` helper (strip `userinfo@` from `http(s)://` and
  `ssh://` URLs) and use it in every log/warn/error interpolation of `repoUrl`, in the `list`
  subcommand output, in `CloneSkipReason.origin_mismatch` messages, and in MCP responses (`repoUrl`,
  `siblingRepositories[].repoUrl`, `configuredRepositories`). Pass git error messages through the
  same redaction before they reach logs or MCP.
- **Acceptance**: Unit tests: a config with `https://u:tok@example.com/r.git` produces log lines and
  MCP payloads containing `https://example.com/r.git` (or `https://***@example.com/r.git`) and never
  the token; a mocked git error containing the URL is redacted in the MCP error response.
- **Notes**: Coordinator's own finding from a grep of every interpolation of `repoUrl` into
  logger/error strings and of the MCP response builders.

### [x] T51. `pnpm lint` never lints TypeScript: the eslint glob covers 6 root JS files, so all 75 source and 77 test `.ts`/`.tsx` files ship unlinted and the CI 'Run Linter' step is a no-op for the app

- **Category**: workflow · **Subsystem**: build-ci-tests
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `package.json:13-14` (`scripts.lint / scripts.lint:fix`), `eslint.config.cjs:1-25`,
  `.github/workflows/pr.yml:64-65` (`Run Linter`)
- **Current behavior**: `eslint '**/*.{js,cjs,mjs}'` with `@eslint/js` recommended rules only.
  `eslint --debug` shows exactly six files being linted (demo-recording config, eslint.config.cjs,
  devtools-stub.js, esbuild.config.js, bin/sync-worktrees.js, the example config). No
  `typescript-eslint` (or any TS parser) is installed, so no `.ts`/`.tsx` file can be linted even if
  the glob were widened. Failure scenario: A contributor adds an unused import, an unawaited
  promise, a `no-fallthrough` switch, or an `any`-typed escape hatch in `src/services/*.ts`; `pnpm
  lint` and the PR check both pass. The only guard left is `tsc --noEmit`, which does not catch
  floating promises, unused variables, or import ordering.
- **Expected behavior**: Add `typescript-eslint` (parser + recommended-type-checked rules) and
  `eslint-plugin-react-hooks` for the Ink components, extend the lint glob to
  `**/*.{js,cjs,mjs,ts,tsx}`, and enable at least `@typescript-eslint/no-floating-promises`,
  `no-misused-promises`, `no-unused-vars` and `consistent-type-imports`. Fix or explicitly disable
  the findings the first run produces so `pnpm lint` is green and meaningful again.
- **Acceptance**: `pnpm eslint --debug 2>&1 | grep -c 'Linting code for'` reports > 150 files;
  introducing an unawaited `service.sync()` in a `.ts` file makes `pnpm lint` fail; CI lint step
  fails on the same change.
- **Notes**: Coordinator's own finding, verified by running eslint with --debug.

### [x] T52. PR workflow `paths` filter omits `**.tsx`, `**.cjs`, `**.mjs` and `.github/actions/**`, so a PR that only changes Ink components (18 `.tsx` files) or the composite setup action runs no lint, typecheck, build or tests

- **Category**: workflow · **Subsystem**: build-ci-tests
- **Severity**: Medium · **Verification**: code re-read by the coordinating reviewer
- **Location**: `.github/workflows/pr.yml:3-11` (`on.pull_request.paths`)
- **Current behavior**: `on.pull_request.paths` lists `**.ts`, `**.js`, `**.json`,
  `.github/workflows/**`, `pnpm-lock.yaml`. The repository has 18 `.tsx` source files under
  `src/components` plus `InteractiveUIService.tsx`, an `eslint.config.cjs`, and
  `.github/actions/setup-node-pnpm/action.yml`. GitHub skips the whole workflow when no changed file
  matches, and a skipped required check does not block merging. Failure scenario: A PR that edits
  only `src/components/WorktreeStatusView.tsx` (for example the diverged-delete prompt) is merged
  with zero CI runs; a typecheck or test regression lands on `main` and is only caught by the next
  unrelated PR. The same applies to a change to the composite action that installs dependencies.
- **Expected behavior**: Either drop the `paths` filter entirely (the job is ~2 minutes) or extend
  it to `**.tsx`, `**.cjs`, `**.mjs`, `.github/**`, `tsconfig*.json`, `vitest.config.ts`,
  `esbuild.config.js`; also add `ready_for_review` and `reopened` to `types`. If a filter is kept,
  add a `paths-ignore` for `*.md`/`site/**` instead of an allow-list.
- **Acceptance**: A test PR touching only a `.tsx` file triggers the 'Lint, Type Check & Test' job;
  the branch protection required check is 'completed', not 'skipped'.
- **Notes**: Coordinator's own finding, verified against the workflow file and the repository's file
  types.

---

## Low severity

### [ ] T53. MAX_SAFE_TOTAL_CONCURRENT_OPS validation counts each status check as one process, but every getFullWorktreeStatus spawns 6 git processes in parallel (240 at default settings)

- **Category**: guardrail · **Subsystem**: worktree-sync
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/config-loader.service.ts:436-451` (`validateParallelismConfig total =
  maxRepos × (creation+updates+removal+status)`), `src/services/worktree-status.service.ts:228-247,
  257-282` (`collectSnapshot Promise.all of 6 git commands (+ submodule status children)`),
  `src/services/worktree-mode-sync-runner.ts:465-477` (`prune status checks at maxStatusChecks
  concurrency`), `src/constants.ts:46-54` (`PARALLELISM defaults`)
- **Current behavior**: The loader rejects configs whose summed per-repo limits × maxRepositories
  exceed 100 'operations'. The sum adds phases that never run concurrently (create, prune, update
  are sequential) while a single 'status check' actually launches `status`, `branch -v`, `branch -v
  -r`, `stash list`, `submodule status` and the .git probe concurrently, then up to 4 more
  rev-parse/rev-list in parallel. Default config (2 × 27 = 54) passes, yet the prune phase peak is 2
  repos × 20 checks × 6 = 240 simultaneous git processes (+ one per submodule). Failure scenario: A
  tick in which many worktrees become prune candidates (filter change, mass branch deletion after a
  release) on a large repo: 240 concurrent `git status`/`git branch -v` processes each mapping the
  index and packfiles exhaust file descriptors/memory on a laptop; the codebase's EMFILE fail-closed
  handling then marks worktrees unverifiable and skips them, and the diverged-probe finding above
  becomes reachable. Users tuning `maxStatusChecks` believe it caps git processes.
- **Expected behavior**: Make the cap reflect reality: either run the snapshot commands sequentially
  (they are all fast), or validate `maxRepositories × maxStatusChecks × 6 ≤ limit` and document that
  a status check is ~6 processes; compute the peak per phase instead of summing sequential phases.
  Update the error text and README/example config accordingly.
- **Acceptance**: Config-loader test: default config's computed peak process count is reported (e.g.
  in the error/help text) as 240, or collectSnapshot runs its commands sequentially and the test
  asserts at most one in-flight git call per worktree. Documentation states what one status check
  costs.
- **Notes**: Re-verified: `validateParallelismConfig` (config-loader.service.ts:436-451) adds
  `maxStatusChecks` as one operation per slot, while `getFullWorktreeStatus` fans out six git
  processes per slot (worktree-status.service.ts:228-247) and then up to four more (257-282).

### [ ] T54. `update_check_failed` skip and its log line carry no branch or path, so the user cannot tell which of N worktrees failed the probe

- **Category**: workflow · **Subsystem**: worktree-sync
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/worktree-mode-sync-runner.ts:868-876` (`Phase 4a rejected-result
  handling`), `src/services/worktree-mode-sync-runner.ts:473-475, 506-512` (`prune path attaches
  branchName to the rejection (the pattern to reuse)`),
  `src/services/__tests__/worktree-update.test.ts:179-211` (`test asserts only kind/scope/reason`)
- **Current behavior**: When any probe in Phase 4a throws (status, merge-base, sparse diff…), the
  runner logs ` - Error checking worktree: <git error>` and records `recordSkipped('worktree',
  'update_check_failed', { message })` without `branch` or `path`; simple-git errors contain the
  command and stderr but not the cwd. Failure scenario: Daemon with 200 worktrees; one has a corrupt
  index or sits on an unmounted volume. Every tick prints `Error checking worktree: fatal: index
  file smaller than expected` with no identifier; the MCP `sync` outcome shows a skipped action with
  `branch: undefined`; the user has to bisect 200 directories by hand.
- **Expected behavior**: Attach `{ branch: action.branch, path: action.path }` to the rejection (or
  wrap the probe in try/catch inside the limit callback) and log `Error checking worktree '<branch>'
  (<path>): <error>`; the outcome action must include branch and path like every other skip reason.
- **Acceptance**: worktree-update.test.ts:179-211 extended to assert `branch: 'feature'` and `path:
  '/test/worktrees/feature'` on the `update_check_failed` action, and that the error log line
  contains the branch name.
- **Notes**: Also reported as: “Phase 4a probe failures are recorded as 'update_check_failed'
  without branch or path, unlike the prune path”. Guards checked: The prune path already solves it
  with Object.assign; the update path predates that and its test only checks kind/reason.

### [ ] T55. GitService.updateLogger does not reach WorktreeStatusService/WorktreeMetadataService or cached progress handlers, so in the TUI their log lines bypass the log panel and go to the raw console

- **Category**: workflow · **Subsystem**: worktree-sync
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/git.service.ts:53-64, 107-110` (`constructor captures logger into
  sub-services; updateLogger updates only sparse`), `src/services/git.service.ts:80-91, 93-105`
  (`getCachedGit/buildSimpleGitOptions capture this.logger into makeGitProgressHandler`),
  `src/services/worktree-metadata.service.ts:52-56, 82, 160-161, 199-205` (`warn/info/error lines
  from metadata service`), `src/services/worktree-status.service.ts:229-246, 296-310` (`logger.error
  lines from status probes`), `src/index.ts:182-184` (`daemon mode constructs services without
  config.logger`), `src/services/InteractiveUIService.tsx:85, 115-125, 279-283, 315-316`
  (`injectLoggersIntoServices (startup) and reload: initialize() before logger injection`)
- **Current behavior**: In daemon/TUI mode `WorktreeSyncService` is created with
  `Logger.createDefault()` (console). GitService hands that logger to WorktreeMetadataService and
  WorktreeStatusService at construction. The TUI later calls `service.updateLogger(uiLogger)` →
  `gitService.updateLogger` which only replaces `this.logger` and the sparse service's;
  metadata/status services keep console.* forever. On reload the new services run `initialize()`
  (git.service.ts:120-191 logs 'Fetching remote branches…' etc. through the console logger, and the
  bare/main simple-git clients are cached with a progress handler bound to that logger) before
  `injectLoggersIntoServices` runs. Failure scenario: User runs the TUI; a worktree without metadata
  (manually `git worktree add`-ed, or trash-restored) gets fast-forwarded → 'No metadata found for
  worktree …', 'Attempting to create initial metadata…', '✅ Created metadata …' are written with
  console.log to the terminal under Ink's alternate screen instead of the log panel; a status probe
  failure ('Error reading status for …') is console.error'd and never appears in the panel the user
  is watching. With `debug: true`, fetch progress lines from the reload-time clients also go to the
  console. In MCP mode this is avoided only because context.ts passes `logger` at construction.
- **Expected behavior**: GitService.updateLogger propagates to metadataService and statusService
  (add updateLogger to both) and refreshes progress handlers (store the logger in a mutable holder
  read at emit time instead of capturing it). InteractiveUIService.handleReload injects loggers
  before calling initialize(), or constructs services with `logger` in the config as runOnce mode
  does (index.ts:74-76).
- **Acceptance**: Unit test: after `gitService.updateLogger(l2)`, a metadata warning and a
  status-service error are delivered to l2's outputFn, none to l1. TUI test: during handleReload, no
  console.log/console.error is invoked by service initialization (spy on console).
- **Notes**: Guards checked: updateLogger fan-out was added incrementally
  (worktree-sync.service.ts:380-391 lists nine services) and the two GitService-owned helpers were
  missed; there is no test asserting log routing after updateLogger.

### [ ] T56. Per-worktree simple-git client caches are never evicted (GitService ×2 variants + WorktreeStatusService): ~20 KB retained per branch lifetime in daemon mode

- **Category**: performance · **Subsystem**: worktree-sync
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/git.service.ts:51, 80-91` (`GitService.gitInstances / getCachedGit`),
  `src/services/worktree-status.service.ts:83, 613-623` (`WorktreeStatusService.gitInstances /
  createGitInstance`), `src/services/git.service.ts:845-872` (`removeWorktree — no cache eviction`)
- **Current behavior**: Both caches are keyed by resolved worktree path (GitService additionally by
  LFS-skip flag) and only ever grow; removeWorktree/trash/diverge never delete entries. Each
  instance holds its executor, plugin set, a progress-handler closure with its own bucket map and
  (for the skip variant) a full copy of process.env. Failure scenario: Long-running daemon on an
  active repo (30 feature branches created and deleted per day): every branch leaves 3 cached
  clients ≈ 20 KB → ~200 MB of heap after a year, never reclaimable, plus the same growth in the
  status service; a TUI run over several months keeps growing without any worktree count increase.
- **Expected behavior**: Evict the path's entries in removeWorktree (and in trash/diverge paths that
  bypass it), or key clients by the bare repo and pass `-C <worktree>`, or use a small LRU. Share
  one cache between GitService and WorktreeStatusService (inject getCachedGit as the status
  service's git factory), which also unifies the env/timeout policy.
- **Acceptance**: Unit test: after `removeWorktree(path)` (and after a trash move), `gitInstances`
  no longer contains keys for that path; heap test optional: creating and removing 1,000 worktrees
  leaves cache size ≤ live worktree count.
- **Notes**: Guards checked: Caching was added for spawn-option reuse; no lifecycle hook clears it
  and nothing measures daemon heap.

### [ ] T57. `git check-ignore` after `git status --porcelain -u` is a redundant spawn per dirty worktree (status never lists ignored paths) and passes every untracked path as argv

- **Category**: performance · **Subsystem**: worktree-sync
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/worktree-status.service.ts:114-118, 317-324, 553-577`
  (`checkWorktreeStatus / collectSnapshot / filterUntrackedFiles`),
  `node_modules/simple-git/dist/esm/index.js:2803-2810` (`statusTask: status --porcelain -b -u
  --null (no --ignored)`)
- **Current behavior**: simple-git's status runs `git status --porcelain -b -u --null`, which
  already excludes ignored files (no `--ignored`), so `status.not_added` contains only
  untracked-and-not-ignored paths. filterUntrackedFiles then runs `git check-ignore -- <all of
  them>` which can never remove anything (exit 1 'no match' → return files), adding one process per
  dirty worktree per probe (update gate and both prune probes) and building an argv of every
  untracked path. Failure scenario: A worktree with a large untracked output directory that is not
  gitignored (20k+ generated files): each probe runs check-ignore with tens of thousands of
  arguments; past ARG_MAX (E2BIG) spawn fails, checkWorktreeStatus throws → `update_check_failed`
  every tick instead of the correct `dirty_worktree`. In the common case it is simply a wasted spawn
  on every dirty worktree in every phase.
- **Expected behavior**: Remove the check-ignore step (treat `status.not_added` as the
  untracked-not-ignored list). If a second opinion is ever needed, feed paths via `check-ignore
  --stdin -z` rather than argv.
- **Acceptance**: worktree-status.service.test.ts: no `check-ignore` invocation for a worktree with
  untracked files; behaviour of isClean/untrackedNotIgnored unchanged for the existing fixtures.
  E2E: worktree with `.gitignore` `*.tmp` and an `a.tmp` file is clean; with an unignored `b.txt` it
  is dirty.
- **Notes**: Also reported as: “checkWorktreeStatus spawns `git check-ignore` on the untracked list
  even though `git status` never reports ignored files (redundant per-tick spawn; E2BIG risk on
  large untracked sets)”. Guards checked: The filter was presumably written assuming status could
  report ignored entries; GIT_CHECK_IGNORE_NO_MATCH handling shows the 'nothing matched' outcome is
  the expected normal case.

### [ ] T58. isPathInsideBaseDir uses synchronous existsSync/realpathSync per registered worktree and re-resolves worktreeDir every call (≈41 ms of blocked event loop per sync at 400 worktrees)

- **Category**: performance · **Subsystem**: worktree-sync
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/services/path-resolution.service.ts:25-45, 62-71` (`canonical path helper /
  isPathInsideBaseDir`), `src/services/worktree-mode-sync-runner.ts:63-72`,
  `src/services/trash.service.ts:395`
- **Current behavior**: For every registered worktree the runner calls isPathInsideBaseDir, which
  synchronously walks up missing components with fs.existsSync and calls fs.realpathSync for both
  the worktree path and (again, each time) the base directory. This runs on every sync attempt in
  the TUI/daemon process. Failure scenario: 400 worktrees on local SSD measured 41.5 ms of blocked
  event loop per tick (TUI frame stalls, cron callbacks delayed); on NFS/SMB or a slow network home
  directory each realpath is milliseconds, giving multi-second freezes every tick with all
  repositories' syncs running in the same process.
- **Expected behavior**: Resolve the base directory once per sync and use `fs.promises.realpath`
  (with the same missing-suffix handling) or accept a pre-resolved base; keep the sync variant only
  for the TUI code paths that truly need it.
- **Acceptance**: Runner test: with 400 registered worktrees, `realpathSync`/`existsSync` are not
  invoked (spy on fs), and the async variant is called once for the base dir. Timing: partition loop
  completes without blocking (measure with a setImmediate probe ≤ 5 ms gap).
- **Notes**: Location corrected: `path-resolution.service.ts` is 71 lines; the sync calls are
  `fs.existsSync` (line 29) and `fs.realpathSync` (line 39) in the real-path helper used by
  `isPathInsideBaseDir` (62-71), called per registered worktree from the runner (line 67) and from
  trash restore (trash.service.ts:395).

### [~] T59. No dry-run/plan surface: the planner is pure but there is no CLI or MCP way to preview what a sync will create, prune or update before it mutates

- **Category**: workflow · **Subsystem**: worktree-sync
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/services/worktree-sync-planner.ts:47-55` (`createWorktreeSyncPlan (pure,
  side-effect free)`), `src/services/worktree-mode-sync-runner.ts:83-108` (`plan built then
  immediately executed`), `src/utils/cli.ts:32-125` (`commands: run, init, list, trash — no
  plan/--dry-run`)
- **Current behavior**: The only commands are run (sync), init, list (prints config) and trash. A
  user changing `branchInclude`/`branchMaxAge`/`sparseCheckout` cannot see which worktrees will be
  pruned or created except by running the sync and reading the outcome afterwards (grep confirms no
  dryRun/dry-run anywhere in src). Failure scenario: User tightens `branchMaxAge` from 6m to 30d on
  a repo with 80 worktrees and runs `sync-worktrees --runOnce`; 40 worktrees are moved to trash in
  that tick. Recoverable via trash, but the user had no way to check the plan first, and CI users
  cannot validate config changes without side effects.
- **Expected behavior**: Add `sync-worktrees plan [--config] [--filter] [--no-fetch]` (or
  `--dry-run` on the default command) that acquires the repo lock, optionally fetches, runs
  resolveSyncBranches + getWorktrees + createWorktreeSyncPlan and prints create/prune/update/sparse
  candidates (branch → path, and for prune the safety-status result), exits 0 without mutating;
  optionally expose the same as an MCP tool.
- **Acceptance**: E2E: config with branchInclude excluding an existing worktree → `plan` output
  lists it under prune and the directory still exists afterwards; `plan` on a fully synced repo
  prints empty sections and exit 0.
- **Notes**: Guards checked: The planner refactor created the separation but no command consumes it;
  README/CLI options document only run/init/list.

### [ ] T60. Phase progress emits exactly 5 events per attempt with no processed/total, so the TUI and MCP progress show a static message during long create/prune/update phases

- **Category**: workflow · **Subsystem**: worktree-sync
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/worktree-mode-sync-runner.ts:250, 343, 451, 761, 333` (`the only
  progressEmitter.emit calls`), `src/services/progress-emitter.ts:1-7`
  (`ProgressEvent.processed/total unused by the runner`),
  `src/services/InteractiveUIService.tsx:133-148` (`TUI forwards processed/total`),
  `src/mcp/handlers.ts:578-592` (`MCP progress counter increments per event`)
- **Current behavior**: Only git fetch/clone transfer progress carries numbers (git-progress.ts).
  The runner emits one message at the start of each phase and nothing per item, so a 300-branch
  initial create (serial, checkout-bound) shows 'Creating worktrees for new branches' for the whole
  duration; MCP clients receive `progress: 1..5` for the entire sync. Failure scenario: First run
  against a repo with 300 branches: the TUI status stays on the create message for 30+ minutes with
  no count; an MCP agent polling progress sees the counter stuck at 2 and cannot distinguish a hung
  sync from a slow one.
- **Expected behavior**: Emit `{ phase, message: "Created 'x' (i/n)", processed: i, total: n }`
  after each create/prune/update/sparse item (inside the existing per-item callbacks), and let MCP
  report `progress: processed, total` from the event.
- **Acceptance**: Runner test with 3 create actions asserts three create-phase events with processed
  1..3 and total 3; MCP handler test asserts `progress`/`total` come from the event when present.
- **Notes**: Guards checked: ProgressEvent grew the fields for git transfer progress; the runner was
  never wired to use them (CHANGELOG 4.1.1 notes the percent suffix 'never fired').

### [ ] T61. README states retry.maxAttempts defaults to 'unlimited' but the sync policy defaults to 3; DEFAULT_CONFIG.RETRY constants are bypassed (jitter 500 vs 0)

- **Category**: docs · **Subsystem**: worktree-sync
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `README.md:594-608` (`'retry: { maxAttempts: "unlimited" } // keep trying forever
  (default)'`), `src/services/sync-retry-policy.ts:27-34` (`createOptions literal defaults
  (maxAttempts ?? 3, jitterMs ?? 0)`), `src/constants.ts:38-45` (`DEFAULT_CONFIG.RETRY (MAX_ATTEMPTS
  3, JITTER_MS 500)`)
- **Current behavior**: The README's retry section labels 'unlimited' as the default;
  SyncRetryPolicy uses 3 attempts, 2 LFS retries, 1000/30000 ms, multiplier 2, jitter 0 as inline
  literals; constants.ts defines the same values under DEFAULT_CONFIG.RETRY except JITTER_MS: 500,
  which nothing reads (grep shows no consumer). Failure scenario: A user relying on the README
  leaves `retry` unset expecting the daemon to keep retrying a flaky remote; after three failed
  attempts the sync gives up for that tick and (in runOnce/CI) exits 1. Someone tuning defaults
  edits DEFAULT_CONFIG.RETRY.JITTER_MS and sees no effect.
- **Expected behavior**: README says the default is 3 attempts (and lists the other defaults);
  SyncRetryPolicy reads DEFAULT_CONFIG.RETRY.* instead of literals (decide whether the product
  default jitter is 0 or 500 and delete the other).
- **Acceptance**: sync-retry-policy.test.ts asserts createOptions equals DEFAULT_CONFIG.RETRY
  values; README retry section updated; `grep JITTER_MS src` has a consumer or the constant is
  removed.
- **Notes**: Also reported as: “Docs drift: README says retry default is 'unlimited' (code default
  3), promises LFS-disabled retries, and retry error text points to a removed --skip-lfs flag;
  DEFAULT_CONFIG.RETRY.JITTER_MS is dead”. Guards checked: F11 documented the util-vs-policy split
  but the README text was not updated and constants were added without rewiring the policy.

### [ ] T62. Remote branches ending in '/HEAD' (and ambiguous refname:short cases) are dropped from the sync inventory, so their worktrees are pruned as stale

- **Category**: guardrail · **Subsystem**: worktree-sync
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/git.service.ts:344-355` (`GitService.getRemoteBranches`),
  `src/services/git.service.ts:357-396` (`GitService.getRemoteBranchesWithActivity`),
  `src/services/git.service.ts:1057-1072` (`GitService.getRemoteBranchTips`),
  `src/services/worktree-sync-planner.ts:93-98` (`planPruneActions`),
  `src/services/worktree-mode-sync-runner.ts:271-329, 459-669` (`resolveSyncBranches /
  pruneOldWorktrees`)
- **Current behavior**: getRemoteBranches filters `!b.endsWith("/HEAD")` (git.service.ts:352) and
  getRemoteBranchesWithActivity filters `!ref.endsWith("/HEAD")` (:377) to drop the `origin/HEAD`
  symref. Git accepts `feature/HEAD` as a branch name (verified), so `origin/feature/HEAD` is also
  removed from the inventory. planPruneActions treats any existing worktree whose branch is not in
  remoteBranches as a prune candidate; a clean, fully-pushed worktree passes every safety gate and
  is moved to trash (or `git worktree remove`d when trash is disabled). Separately,
  getRemoteBranchesWithActivity and getRemoteBranchTips parse `%(refname:short)`, which git prints
  as `remotes/origin/<x>` whenever a local branch literally named `origin/<x>` exists (verified);
  such refs fail the `startsWith("origin/")` check and are dropped the same way. This is the same
  defect class as the 5.3.1 fix for `|` and a branch named `origin`. Failure scenario: Remote has
  branch `feature/HEAD`. Sync never creates it (inventory shows only `main`). User creates it
  through the TUI branch wizard or MCP create_worktree (both call gitService.addWorktree directly;
  InteractiveUIService.tsx:783-790), pushes, works in it. Next sync: `feature/HEAD` is absent from
  remoteBranches -> check-prune -> clean & `rev-list --not --remotes`=0 -> moved to .trash
  (verified: outcome `{"kind":"removed","branch":"feature/HEAD"}`, directory gone, trash entry
  created). With trash disabled it is `git worktree remove`d outright. It is never recreated on any
  later sync. Variant: remote has both `x` and `origin/x`; after `origin/x` gets a local branch,
  `x`'s short ref becomes `remotes/origin/x` under branchMaxAge and `x`'s worktree is pruned.
- **Expected behavior**: Only the actual symref `refs/remotes/origin/HEAD` is excluded: compare the
  full ref (`ref === 'refs/remotes/origin/HEAD'`) or check `%(symref)`/`branch -r` arrow lines,
  never `endsWith('/HEAD')` on the stripped name. Inventory parsing must use `%(refname)` and strip
  the literal prefix `refs/remotes/origin/` instead of `%(refname:short)`. A worktree whose branch
  still exists on the remote must never be planned for prune.
- **Acceptance**: Unit tests: getRemoteBranches with `origin/feature/HEAD` and `origin/HEAD ->
  origin/main` in `branch -r` output returns ['feature/HEAD','main'] (HEAD symref excluded,
  feature/HEAD kept); getRemoteBranchesWithActivity/getRemoteBranchTips with a local branch
  `origin/x` present still return `x`. E2E (like e2e/head-branch-filter.test.ts): remote with
  `feature/HEAD`; after `addWorktree('feature/HEAD', ...)` a second sync leaves the worktree in
  place and no trash entry is created; a fresh sync also creates it.
- **Notes**: Guards checked: The 5.3.1 change fixed `|` and `origin` in the same functions but kept
  the suffix-based HEAD filter; head-branch-filter e2e only asserts that no `HEAD` worktree is
  created. No guard exists downstream: prune trusts the inventory, and the safety gates
  (clean/pushed/stash/op) all pass for an ordinary pushed branch. Trash makes it reversible but the
  branch is silently removed from the managed set forever.

### [ ] T63. isWorktreeBehind uses @{upstream} while canFastForward/updateWorktree use origin/<branch>: a differing upstream yields a phantom 'updated/fast_forward' outcome every sync

- **Category**: correctness · **Subsystem**: worktree-sync
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/git.service.ts:1150-1170` (`GitService.isWorktreeBehind`),
  `src/services/git.service.ts:1172-1194` (`GitService.updateWorktree`),
  `src/services/git.service.ts:1215-1232` (`GitService.canFastForward`),
  `src/services/worktree-mode-sync-runner.ts:814-825, 888-894` (`updateExistingWorktrees phase
  4a/4b`)
- **Current behavior**: Phase 4a decides 'behind' from `rev-list HEAD..<branch>@{upstream}`, but the
  merge (and the ff/ahead probes) target `origin/<current branch>`. When the worktree's upstream is
  anything other than origin/<branch> (user ran `git branch -u origin/main`, or a branch created
  with `--track` of another ref), the merge is a no-op yet the runner logs 'Successfully updated',
  records `updated/fast_forward`, and updateLastSyncFromPath rewrites lastSyncCommit to HEAD — on
  every tick. Failure scenario: feat worktree; user sets upstream to origin/main to see 'behind
  main' in their prompt. main advances. Every sync: isWorktreeBehind -> true; updateWorktree merges
  origin/feat --ff-only -> 'Already up to date'; outcome counts.updated++ with reason fast_forward
  while HEAD is unchanged (verified: HEAD before==after true, action recorded on sync 2 and sync 3).
  Dashboards/MCP consumers see continuous phantom updates; metadata syncHistory fills with bogus
  'updated' entries.
- **Expected behavior**: Use one reference consistently — compute 'behind' against
  origin/<action.branch> (the ref the merge uses) — and have updateWorktree return whether HEAD
  actually moved so the runner records noop/already_up_to_date when it did not.
- **Acceptance**: Unit test with isWorktreeBehind true but updateWorktree leaving HEAD unchanged ->
  outcome noop, not updated; e2e: after `git branch -u origin/main` in a feature worktree and a push
  to main, sync records no 'updated' action for that worktree and metadata lastSyncDate is
  unchanged.
- **Notes**: Guards checked: worktree-update.test.ts mocks both probes independently so the
  inconsistency is invisible; no e2e sets a non-default upstream.

### [ ] T64. Sparse reconcile (Step 5) is not idempotent for includes with a trailing slash: re-applies patterns and runs `git checkout HEAD` on every worktree every sync

- **Category**: correctness · **Subsystem**: worktree-sync
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/worktree-mode-sync-runner.ts:134-135, 152-155` (`reapplySparseCheckout
  compare/apply`), `src/services/sparse-checkout.service.ts:375-392`
  (`buildPatterns/buildPatternsForMode (no trailing-slash normalization)`),
  `src/services/sparse-checkout.service.ts:466-471` (`patternsEqual`),
  `src/services/sparse-checkout.service.ts:521-524` (`getMatcher (does strip trailing slash)`)
- **Current behavior**: `git sparse-checkout list` prints `apps` for a cone include written as
  `apps/` (verified). buildPatterns only trims whitespace, so patternsEqual(['apps'], ['apps/']) is
  false, isNarrowing is false, and applyToWorktree + checkoutHead run for every existing worktree on
  every sync, each recording `updated/sparse_checkout`. getMatcher (used for
  skipUpdateWhenOutsideSparse) does strip the slash, showing the config form is expected. Failure
  scenario: Config `sparseCheckout: { include: ['apps/', 'tools/'] }` with 300 worktrees: every tick
  runs 600 extra git commands (sparse-checkout set + checkout HEAD) per repo, the outcome reports
  300 'updated' actions each sync, and MCP/TUI users see perpetual updates.
- **Expected behavior**: Normalize cone patterns (strip trailing '/') in buildPatternsForMode, or
  compare against a normalized form of both sides, so a second sync with unchanged config records no
  sparse action.
- **Acceptance**: Unit: buildPatterns({include:['apps/']}) equals readCurrent output ['apps'] via
  patternsEqual; runner test with readCurrent ['apps'] and config ['apps/'] does not call
  applyToWorktree or checkoutHead.
- **Notes**: Re-verified: `buildPatternsForMode` only trims (sparse-checkout.service.ts:54-67) and
  `patternsEqual` is an exact ordered comparison (141-146), while `git sparse-checkout list` prints
  cone directories without a trailing slash, so an include written as `dir/` can never compare
  equal.

### [ ] T65. `sanitizeGitEnv` forwards repository-discovery variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, ...); when sync-worktrees is launched from a git hook, clone-mode's config rewrites, ref deletions and merges target the hook's repository instead of `worktreeDir`

- **Category**: guardrail · **Subsystem**: clone-sync
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/utils/git-env.ts:9-15` (`sanitizeGitEnv`),
  `src/services/clone-sync.service.ts:184-190` (`CloneSyncService.buildGitEnv`),
  `src/services/clone-sync.service.ts:213-217, 402-427, 1013` (`configureSingleBranchRemote /
  deleteStaleRemoteTrackingRefs / merge`)
- **Current behavior**: `buildGitEnv` spreads `sanitizeGitEnv(process.env)`, which strips only
  `EDITOR`, `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`. git honours
  `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR`/`GIT_INDEX_FILE`/`GIT_OBJECT_DIRECTORY` over cwd-based
  discovery, and simple-git only sets `cwd`. git exports `GIT_DIR` (and in pre-commit hooks
  `GIT_INDEX_FILE`) to hook processes, so a `post-merge`/`post-checkout` hook that runs
  `sync-worktrees --config ...` to refresh sibling clones makes every clone-mode subprocess operate
  on the hook's repository. Failure scenario: Repo A has a `post-merge` hook: `sync-worktrees
  --config ~/ws/sync-worktrees.config.js` (clone-mode entries for sibling repos B, C). git runs the
  hook with `GIT_DIR=/path/A/.git`. For entry B the service executes `git config --replace-all
  remote.origin.fetch +refs/heads/main:refs/remotes/origin/main` and `update-ref -d
  refs/remotes/origin/*` — both land in repo A (its refspec is narrowed to B's branch and its
  remote-tracking refs are deleted); `rev-parse --abbrev-ref HEAD` reads A's branch so the branch
  check may pass or soft-skip depending on names; a subsequent `merge --ff-only` would run against
  A. Verified (scratch exp7, git 2.43): with `GIT_DIR` pointing at another repo, `git config
  --replace-all` and `update-ref -d` executed from the clone directory modified the other repo and
  left the clone directory untouched.
- **Expected behavior**: `sanitizeGitEnv` additionally deletes `GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
  `GIT_NAMESPACE` (repository-selection variables), keeping auth/proxy/PATH. Note the same
  protection is needed for clients that inherit `process.env` without `.env()` (GitService default
  clients, WorktreeStatusService, SparseCheckoutService, GitMaintenanceService) — cover them via a
  shared spawn env or by deleting those keys from `process.env` at startup.
- **Acceptance**: Unit test for `sanitizeGitEnv`: input with `GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_INDEX_FILE` set → output lacks them and keeps `PATH`/`HOME`/`SSH_AUTH_SOCK`/`GIT_ASKPASS`.
  Integration test: create two local repos, run a clone-mode `runSyncAttempt` against repo B with
  `process.env.GIT_DIR` pointing at repo A → repo A's `remote.origin.fetch` and
  `refs/remotes/origin/*` unchanged and B's are narrowed.
- **Notes**: Applies beyond clone mode: default simple-git clients inherit `process.env` unchanged,
  so an exported `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` redirects worktree-mode commands as
  well. Strip the repository-discovery variables in `sanitizeGitEnv` and pass the sanitized env to
  every client. Also reported as: “sanitizeGitEnv forwards GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE
  from the parent, redirecting every clone-mode git command to another repository when the tool runs
  from a git hook or a shell that exports GIT_DIR”.

### [ ] T66. With a small configured `depth`, every routine sync re-passes `--depth N` and re-shortens the history the previous tick deepened; at `depth: 1` every remote advance (even +1 commit) is indeterminate and costs a 50-commit deepen fetch, then is thrown away

- **Category**: performance · **Subsystem**: clone-sync
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/services/clone-sync.service.ts:204-211` (`CloneSyncService.buildFetchArgs`),
  `src/services/clone-sync.service.ts:306-312` (`CloneSyncService.getDeepenTargets`),
  `src/services/clone-sync.service.ts:951-960` (`runSyncAttemptInternal (deepen loop)`)
- **Current behavior**: `buildFetchArgs` adds `--depth <configured>` whenever the repo is shallow.
  `git fetch --depth N` re-truncates history to N (the code comment at 309-310 acknowledges
  shortening). After a deepen-to-50 and fast-forward, the next tick's `--depth 1` fetch cuts local
  history back to 1 commit, and with depth 1 the newly fetched tip's parent link is cut, so
  `merge-base HEAD origin/<b>` fails even when the remote moved by exactly one commit →
  `indeterminate_shallow` → deepen to 50 again. Failure scenario: `depth: 1`, hourly cron, active
  upstream. Tick 1: remote +3 → `--depth 1` fetch, classify indeterminate, `[deepen] ... depth 50`
  fetch (50 commits), ff, `rev-list --count HEAD` = 8. Tick 2: `--depth 1` fetch shortens to 1
  commit; remote +1 → merge-base fails again → another 50-commit deepen. Every update pays a
  50-commit fetch plus a re-shorten; the `fast_forward` fast path never triggers for depth 1.
  Verified in scratch exp3 (git 2.43): after ff `count=8`, after next `--depth 1` fetch `count=1`,
  and with remote +1 `merge-base` exit 1.
- **Expected behavior**: Do not pass `--depth` on routine sync fetches once the clone exists (a
  shallow repo stays shallow at its current boundary and simply accrues new commits), or pass it
  only when the current depth (`git rev-list --count HEAD`) is below the configured value. `depth`
  then bounds the initial clone and the deepen budget, matching the README wording "optional shallow
  clone". Update README line 425 accordingly.
- **Acceptance**: Unit test: `depth: 1`, shallow repo, `classify` → `indeterminate_shallow` then
  `fast_forward`; on the following `runSyncAttempt` the fetch args do not contain `--depth`. E2E
  (extend `deepens shallow clone history when remote is multiple commits ahead`): run a third sync
  after one more push and assert the log contains no second `[deepen]` line and `rev-list --count
  HEAD` did not decrease between runs.
- **Notes**: Also reported as: “Shallow clone-mode sync fetches with `--depth N` re-truncate history
  every tick, forcing a second 'deepen' network fetch on every tick that has new commits”. Guards
  checked: Looked for: a guard comparing current vs configured depth before adding `--depth` (none;
  only `isShallowRepository`); `--deepen` usage (none); tests (they assert `--depth 1` is present on
  every sync fetch, e.g. lines 955-977, 1049-1057, so the churn is baked into the contract). README
  425 says sync fetches "keep only the tracked branch at the configured depth", so this is partly a
  design choice — reported as performance, not correctness.

### [ ] T67. Clone-init pending marker is written after `configureSingleBranchRemote`, so a crash in that window leaves a marker-less valid clone whose file copy is silently dropped forever (contradicting the comment at 659-662)

- **Category**: correctness · **Subsystem**: clone-sync
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/clone-sync.service.ts:641-667` (`CloneSyncService.initializeInternal
  (post-clone ordering)`)
- **Current behavior**: After `clone()` resolves (line 642) the code runs
  `configureSingleBranchRemote` (four+ git subprocesses, lines 653-654) and only then writes
  `.git/.sync-worktrees-clone-init.pending` (664). The comment claims the marker covers "from here
  to the end of runInitialFileCopy", but the existing-clone path (612-619) runs the file copy only
  when the marker exists. Failure scenario: Fresh clone-mode init with `filesToCopyOnBranchCreate:
  [".env.local"]`; the process is killed (SIGKILL, OOM, power loss) between the clone finishing and
  the marker write. Next run: `.git` present, no pending marker → adopted as a pre-existing clone;
  `configureSingleBranchRemote` re-runs (fine) but `.env.local` is never copied and no warning is
  ever logged.
- **Expected behavior**: Write the pending marker immediately after `clone()` resolves, before
  `configureSingleBranchRemote` (which is idempotent and re-run on adoption anyway). Keep the
  existing best-effort warning on write failure.
- **Acceptance**: Unit test: record `fs.writeFile`/`gitMock.raw` call order and assert the
  pending-marker write precedes the first `["config","--replace-all","remote.origin.fetch",...]`
  call. Existing pending-marker resume tests (474-533) unchanged.
- **Notes**: Guards checked: Looked for: marker write placement (after config, line 664); any second
  mechanism that detects a never-copied clone (none — `runInitialFileCopy` is gated on the pending
  marker in the adoption path). CHANGELOG 5.3.1 "resume an interrupted clone init's file copy via a
  pending marker" describes the mechanism but the window before the marker is uncovered.

### [ ] T68. Clone-mode sparse re-apply skips the README's "narrowing safety" check and does not record failures/skips in the sync outcome, unlike worktree mode

- **Category**: docs · **Subsystem**: clone-sync
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/clone-sync.service.ts:927-938` (`runSyncAttemptInternal (sparse
  re-apply)`), `src/services/worktree-mode-sync-runner.ts:133-163` (`sparse update with
  isNarrowing/getFullWorktreeStatus`), `README.md:466` (`Narrowing safety paragraph`)
- **Current behavior**: README 466 promises that a narrowing sparse update first checks the worktree
  is clean and otherwise skips with a warning. Worktree mode implements this (`isNarrowing` →
  `getFullWorktreeStatus` → `sparse_narrowing_unsafe` skip, and `sparse_checkout_failed` on error).
  Clone mode calls `applyToWorktree` whenever `needsUpdate` is true, before its own dirty check, and
  on failure only logs a warning; the outcome records nothing, so `counts.failed`/`skipped` and the
  exit code cannot reflect a broken sparse config. git itself preserves modified/staged/untracked
  files when narrowing (verified: scratch exp8 — `warning: ... were left despite sparse patterns`,
  files intact), so there is no data loss, only a documentation/observability gap. Failure scenario:
  Clone-mode repo with `sparseCheckout.include` changed to an invalid cone pattern. Each tick:
  `Failed to reapply sparse-checkout ...` warning, then the merge proceeds; `runOnce` exits 0 and
  the outcome shows `updated`/`noop` only, so CI never learns the sparse config is broken.
  Conversely, a user reading README 466 expects narrowing to be refused on a dirty tree; in clone
  mode it proceeds (safely, because git keeps the files, but with git's warning rather than the
  tool's skip).
- **Expected behavior**: Either implement the same gate in clone mode (`isNarrowing(readCurrent,
  buildPatterns)` → `checkWorktreeStatus` → `outcome.recordSkipped("sparse-checkout",
  "sparse_narrowing_unsafe", ...)`) and record `recordFailed("sparse-checkout", ..., { reason:
  "sparse_checkout_failed" })` on error, or amend README 466 to state that clone mode re-applies
  unconditionally and relies on git's own preservation.
- **Acceptance**: Unit test: `needsUpdate` → true, `isNarrowing` → true, `checkWorktreeStatus` →
  false → `applyToWorktree` not called and outcome contains a skipped `sparse_narrowing_unsafe`
  action; `applyToWorktree` rejecting → `outcome.counts.failed === 1`. If the docs route is chosen:
  README paragraph updated and the existing `reapplies sparse-checkout when needsUpdate returns
  true` test unchanged.
- **Notes**: Guards checked: Looked for: `isNarrowing` usage (only in
  worktree-mode-sync-runner.ts:137); outcome recording around the clone-mode sparse block (none);
  README qualification for clone mode (none at 466).

### [ ] T69. `filesToCopyOnBranchCreate` globs walk every sibling repository checkout under the config directory and copy their files into the new clone

- **Category**: guardrail · **Subsystem**: clone-sync
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/file-copy.service.ts:8-15, 77-98` (`DEFAULT_IGNORE_PATTERNS /
  FileCopyService.expandPatterns`), `src/services/clone-sync.service.ts:805-833`
  (`CloneSyncService.runInitialFileCopy`), `README.md:617` (`filesToCopyOnBranchCreate doc`)
- **Current behavior**: Patterns are globbed with `cwd: __configFileDir`, `dot: true`, ignoring only
  `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`. Configured `worktreeDir`s
  (clone-mode checkouts and worktree-mode trees) almost always live under the config directory
  (README quick start), so a recursive pattern matches files inside every other repository checkout,
  and each match is copied to `<worktreeDir>/<relative path including the sibling repo prefix>`.
  Failure scenario: Config dir `/ws` with clone-mode entries `api` (`/ws/api`) and `web`
  (`/ws/web`), `defaults.filesToCopyOnBranchCreate: ["**/.env.local"]` intended for
  `/ws/.env.local`. Initializing `web` after `api` exists copies `/ws/.env.local` →
  `/ws/web/.env.local` (intended) and `/ws/api/.env.local` → `/ws/web/api/.env.local` (pollution: a
  foreign, possibly secret-bearing file dropped into the checkout; `git status` shows it untracked →
  `dirty_tree` skip on every sync). With a worktree-mode sibling holding 50 worktrees the glob also
  walks all of them on every branch creation.
- **Expected behavior**: Build the glob `ignore` list from the loaded config: exclude the
  destination `worktreePath` and every repository's resolved `worktreeDir`/`bareRepoDir` (relative
  to `sourceDir`) plus `.trash`, `.diverged`, `.removed`, `.sync-worktrees-state`; or document that
  patterns must not be recursive. Copy must never read from another configured repository's
  checkout.
- **Acceptance**: Unit test for `FileCopyService.copyFiles(sourceDir, destDir, ["**/.env"], {
  ignore: [...] })` where `sourceDir` contains `.env`, `other-repo/.env` (listed as excluded) and
  `dest/.env` → only `.env` is copied. Clone-sync unit test asserting the ignore list passed to
  `copyFiles` contains all configured worktreeDirs.
- **Notes**: Re-verified: `expandPatterns` globs with `cwd: sourceDir` (the config directory), `dot:
  true` and an ignore list that covers node_modules/.git/dist/build but not the sibling checkouts
  that live under the config directory (file-copy.service.ts:8-15, 77-98).

### [ ] T70. The destructive `rm -rf` branch of `maybeCleanupPartialClone` has no test; only the negative (EACCES) case asserts `fs.rm` is not called

- **Category**: testing · **Subsystem**: clone-sync
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/services/clone-sync.service.ts:763-795`
  (`CloneSyncService.maybeCleanupPartialClone`),
  `src/services/__tests__/clone-sync.service.test.ts:459-472` (`refuses to proceed when the
  pre-clone directory probe fails`)
- **Current behavior**: The only recursive delete in the clone-mode subsystem is guarded by three
  conditions (`cloneCreatedDir`, all entries dot-prefixed, no usable `.git/HEAD`). No test exercises
  the positive path or the two "leave in place" branches, so a regression that drops any guard (e.g.
  deleting when the directory pre-existed) would pass the suite. grep of the test file shows `fs.rm`
  referenced only for the `.pending` marker and the not-called assertion. Failure scenario: A future
  refactor removes the `cloneCreatedDir` check or the `hasUsableGit` check; a failed clone into a
  pre-existing directory (or a checkout-failed clone) is deleted; the suite stays green.
- **Expected behavior**: Add unit tests: (1) `readdir` → ENOENT, clone rejects, post-failure
  `readdir` → [".git"] and `.git/HEAD` missing → `fs.rm(worktreeDir, {recursive:true, force:true})`
  called once; (2) same but `readdir` → [] (dir pre-existed, `cloneCreatedDir` false) → `fs.rm` not
  called and the "directory existed before clone attempt" warning logged; (3) `.git/HEAD` present →
  `fs.rm` not called and the "post-failure contents" warning logged; in all cases the outcome
  contains `failed` with `reason: "clone_failed"` and `initialize()` rejects.
- **Acceptance**: Three new `it` blocks in the `initialize` describe of clone-sync.service.test.ts
  as specified; `pnpm vitest run src/services/__tests__/clone-sync.service.test.ts` passes.
- **Notes**: Also reported as: “maybeCleanupPartialClone (the subsystem's only rm -rf) and the
  clone_failed outcome path have no unit tests”. Guards checked: Searched the test file for `fs.rm`,
  `maybeCleanupPartialClone`, `Cleaned up incomplete` — only lines 471, 478, 499, 506 reference
  `fs.rm`, none for the worktreeDir removal.

### [ ] T71. Clone-mode sync runs a full `git status` scan every tick before learning the clone is already up to date; a dirty but current clone is reported as a skip instead of up-to-date

- **Category**: performance · **Subsystem**: clone-sync
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/clone-sync.service.ts:940-949` (`runSyncAttemptInternal
  (checkWorktreeStatus gate)`), `src/services/clone-sync.service.ts:951-974`
  (`runSyncAttemptInternal (classifyRemoteRelationship / up_to_date)`),
  `src/services/worktree-status.service.ts:99-121` (`WorktreeStatusService.checkWorktreeStatus`),
  `src/services/worktree-sync.service.ts:491-508` (`WorktreeSyncService.sync (init then immediate
  runSyncAttempt)`)
- **Current behavior**: Per tick the order is: fetch (913) -> show-ref (918) -> sparse (927) ->
  `checkWorktreeStatus` (940) -> `classifyRemoteRelationship` (951). `checkWorktreeStatus` runs `git
  status --porcelain -b -u --null` (simple-git default args), a full index refresh + untracked-file
  walk of the whole working tree, and it runs unconditionally — even though the classification that
  follows uses only ref reads (`rev-parse HEAD`, `rev-parse refs/remotes/origin/<b>`, `merge-base`)
  and returns `up_to_date` for the overwhelmingly common daemon case where nothing changed. Counting
  spawns for a steady-state, up-to-date, full (no depth) clone with no sparse config: rev-parse
  --abbrev-ref HEAD, remote get-url, rev-parse --is-shallow-repository, 2x config --replace-all,
  for-each-ref, fetch, show-ref --verify, status, rev-parse HEAD, rev-parse origin/<b> = 11 git
  processes per tick, of which `status` is the only one that scales with working-tree size.
  Secondary effect: because the dirty check precedes classification, a clone that has local
  uncommitted edits but is already at origin/<b> records a `dirty_tree` skip every tick
  (index.ts:145-153 prints '⚠️ Clone-mode skips' and counts the repo as 'with clone-mode skips'
  rather than synced; TUI shows it as a skip) even though there is nothing to merge. Also, in
  `WorktreeSyncService.sync()` a fresh clone is immediately followed by a full `runSyncAttempt`
  (second fetch + status scan of the just-checked-out tree) although the clone is at the remote tip
  by construction. Failure scenario: Daemon with `cronSchedule: '*/5 * * * *'` and several
  clone-mode monorepo siblings (hundreds of thousands of files, no fsmonitor). Every 5 minutes each
  repo pays a full working-tree stat walk (seconds, tens of seconds on network/cold-cache
  filesystems, and it holds the repo lock meanwhile) only to conclude 'already up to date'. A
  developer with a WIP edit in one of those clones sees '⚠️ Clone-mode skips: <repo> — working tree
  has local changes' every tick and the runOnce summary says '0 synced, 1 with clone-mode skips'
  although the clone is current.
- **Expected behavior**: Reorder `runSyncAttemptInternal`: after the post-fetch ref verification,
  call `classifyRemoteRelationship` (with the existing deepen loop) first; when the result is
  `up_to_date` record the noop and return without touching the working tree; when it is
  `local_ahead` / `diverged` / `indeterminate_shallow` record the corresponding skip without a
  status scan; only when it is `fast_forward` run `checkWorktreeStatus` and record `dirty_tree` if
  dirty, otherwise merge. Additionally, `WorktreeSyncService.sync()` should skip `runSyncAttempt`
  for the tick in which `initialize()` performed the clone (the outcome already records `created`),
  or `runSyncAttemptInternal` should short-circuit when init just cloned. Optionally collapse
  `show-ref --verify` + the two `rev-parse` calls into one `git rev-parse HEAD
  refs/remotes/origin/<b>` (missing ref -> exit 128 -> treat as missing_remote_ref) to bring the
  steady-state spawn count from 11 to ~7.
- **Acceptance**: Unit tests: (1) `classifyRemoteRelationship` resolves 'up_to_date' with
  `checkWorktreeStatus` mocked to false -> outcome records `noop already_up_to_date`,
  `checkWorktreeStatus` is never called, no `dirty_tree` skip. (2) 'diverged' + dirty -> `diverged`
  skip recorded, status not called. (3) 'fast_forward' + dirty -> `dirty_tree` skip, no merge
  (existing test keeps passing). (4) fresh-clone init followed by `sync()` issues exactly one fetch
  (the clone) and does not call `status`. A timing note in the PR: `git status --porcelain -b -u
  --null` vs `git rev-parse` on the 36k-file scratch repo (measured 42-106 ms vs 4-5 ms warm; the
  gap grows with tree size and cold caches).
- **Notes**: Guards checked: Looked for caching or short-circuits: none — `checkWorktreeStatus` has
  no cache and is unconditional; `classifyRemoteRelationship` does not depend on the working tree;
  tests ('skips ff-merge when working tree is dirty', 'no-ops when already up to date') pin the
  current order only implicitly (dirty test uses default classify=fast_forward, so reordering keeps
  them green). Not described as intended in CHANGELOG 5.2.0/5.3.1 (those entries concern
  removal-side status checks with --ignore-submodules=none).

### [ ] T72. TUI reports the worktree-mode constant 'main' as the default branch of clone-mode repos (F10 fix incomplete: only the MCP handler was corrected)

- **Category**: correctness · **Subsystem**: clone-sync
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/InteractiveUIService.tsx:511-519`
  (`InteractiveUIService.getDefaultBranchForRepo`), `src/services/git.service.ts:263-265`
  (`GitService.getDefaultBranch`), `src/components/BranchCreationWizard.tsx:95-99, 383-389`
  (`loadBranches / '(default)' marker`), `src/services/worktree-sync.service.ts:181-186`
  (`WorktreeSyncService.getDefaultBranch (already clone-aware)`)
- **Current behavior**: `getDefaultBranchForRepo` returns
  `service.getGitService().getDefaultBranch()`, which for clone-mode repos is the constructor
  constant 'main' because `GitService.initialize()` never runs in clone mode. REVIEW_FINDINGS F10
  fixed exactly this defect for the MCP `initialize` handler ('Never report the worktree-mode
  constant for a clone-mode repo') and `WorktreeSyncService.getDefaultBranch()` is already
  clone-aware (delegates to `resolveBranch()`), but the TUI still reads the GitService constant. The
  wizard uses the value to pre-select the base branch and to render the '(default)' marker. Failure
  scenario: Clone-mode repo with `branch: 'develop'` (or no branch and a remote whose HEAD is
  'master'). Wizard branch list from `ls-remote --heads` contains main, develop, master...; the
  picker pre-selects and labels 'main (default)' although the clone tracks develop; a user pressing
  Enter creates the new branch from the wrong base.
- **Expected behavior**: `getDefaultBranchForRepo` should use `service.getDefaultBranch()`
  (WorktreeSyncService, clone-aware). Because `resolveBranch()` is async and may hit the network
  when `branch` is unset, either make the TUI accessor async (the wizard already awaits
  `getBranchesForRepo` in the same effect) or return `service.config.branch ?? cached resolved
  branch` and fall back to the GitService value only for worktree mode.
- **Acceptance**: interactive-ui.service.test.ts: clone-mode mock service with `getDefaultBranch`
  resolving 'develop' -> `getDefaultBranchForRepo(0)` yields 'develop' and
  `mockGitService.getDefaultBranch` is not called for clone mode; BranchCreationWizard test: with
  branches ['main','develop'] and default 'develop', the initial selection index is 1 and
  '(default)' is rendered next to develop.
- **Notes**: Guards checked: F10 is marked done but its location list covered only
  `src/mcp/handlers.ts:495`; grep shows the TUI accessor still calls `gitService.getDefaultBranch()`
  and its test (interactive-ui.service.test.ts:1677-1686) asserts that call on a worktree-mode mock,
  so the clone-mode value is untested.

### [ ] T73. checkoutBranch on a shallow clone throws FastForwardError when merge-base is merely indeterminate (duplicated, diverging fast-forward logic vs classifyRemoteRelationship)

- **Category**: correctness · **Subsystem**: clone-sync
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/services/clone-sync.service.ts:380-400`
  (`CloneSyncService.localBranchCanFastForward`), `src/services/clone-sync.service.ts:527-530`
  (`checkoutBranch (FastForwardError)`), `src/services/git.service.ts:1252-1281`
  (`GitService.classifyRemoteRelationship`)
- **Current behavior**: `localBranchCanFastForward` re-implements the relationship check that
  `classifyRemoteRelationship` already provides, but with different semantics: it treats any
  `merge-base` failure as 'cannot fast-forward' (`return false`), while `classifyRemoteRelationship`
  distinguishes `indeterminate_shallow` (and the sync path then deepens 50/200/1000 before
  deciding). In a `depth: N` clone the `--depth N` fetch in `buildFetchArgs` (line 206-208) cuts the
  history under the target branch's new tip, so `merge-base refs/heads/<b> refs/remotes/origin/<b>`
  exits 1 whenever the remote moved by more than N commits, and `checkoutBranch` throws
  `FastForwardError(branch)` ('cannot fast-forward') for a branch that is perfectly
  fast-forwardable. It also spends 3 spawns (2 rev-parse + merge-base) where `git merge-base
  --is-ancestor local remote` is one. Failure scenario: Clone-mode repo with `depth: 1`; the user
  previously switched to `feature/x` (local branch exists), switched back, and `feature/x` gained 2
  commits on the remote. Switching to `feature/x` again: fetch --depth 1 -> merge-base fails ->
  FastForwardError 'feature/x' — the TUI shows a misleading 'cannot fast-forward' and there is no
  way to converge short of deleting the local branch. (Reachability note: today this path is only
  reachable after the clone-mode wizard defect above is fixed, or via any future caller of
  `checkoutBranch`.)
- **Expected behavior**: Delete `localBranchCanFastForward` and reuse
  `classifyRemoteRelationship`-style logic (extract a helper taking explicit local/remote refs, or
  pass `refs/heads/<b>` as the 'head' ref). On `indeterminate_shallow` apply the same deepen targets
  used by `runSyncAttemptInternal` before deciding; throw FastForwardError only for a genuine
  `diverged`/`local_ahead` result. Keep one implementation of the relationship classification so the
  two cannot drift.
- **Acceptance**: clone-sync test: `depth:1`, local branch exists, `merge-base` raw mock rejects
  once then (after a fetch with `--depth 50`) returns the local sha -> `checkoutBranch` succeeds and
  issues `switch` + `merge --ff-only`. Test: merge-base returns a third sha -> FastForwardError
  still thrown. grep shows a single merge-base-based classifier in src/services.
- **Notes**: Guards checked: Looked for deepening in checkoutBranch (none; only
  `unshallowIfDepthRemoved`, which is a no-op when depth is configured); tests 'does not switch to
  an existing local branch that cannot fast-forward' only cover a real divergence (distinct
  merge-base sha).

### [ ] T74. configureSingleBranchRemote rewrites .git/config twice and scans remote refs on every sync tick although the fetch never uses the stored refspec

- **Category**: performance · **Subsystem**: clone-sync
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/clone-sync.service.ts:213-217`
  (`CloneSyncService.configureSingleBranchRemote`), `src/services/clone-sync.service.ts:909`
  (`runSyncAttemptInternal (per-tick call)`), `src/services/clone-sync.service.ts:403-427`
  (`deleteStaleRemoteTrackingRefs`), `src/services/clone-sync.service.ts:204-211` (`buildFetchArgs
  (explicit refspec)`)
- **Current behavior**: Every `runSyncAttemptInternal` calls `configureSingleBranchRemote`, which
  unconditionally runs `git config --replace-all remote.origin.fetch ...`, `git config --replace-all
  remote.origin.tagOpt --no-tags` and `git for-each-ref refs/remotes/origin` (3 spawns). `git config
  --replace-all` rewrites `.git/config` (new inode via config.lock rename) even when the value is
  unchanged. The sync fetch passes its refspec explicitly (`buildFetchArgs`), and the only fetch
  that relies on the stored refspec (`--unshallow`, line 900) runs BEFORE this call, so the per-tick
  rewrite converges nothing the tick itself needs; init (line 603/654) and checkoutBranch (line 547)
  already converge the config when it can actually change. Failure scenario: Daemon with 20
  clone-mode repos on a 1-minute schedule: 60 needless git processes and 40 `.git/config` rewrites
  per minute (fs churn, backup/sync tools such as Dropbox/Time Machine see the config file change
  every tick, and any concurrent user `git config` write races config.lock).
- **Expected behavior**: Converge remote config only when it differs: read `git config --get-all
  remote.origin.fetch` / `--get remote.origin.tagOpt` and write only on mismatch (or skip the
  per-tick call entirely and rely on init/checkout convergence, re-running it only when the refspec
  read shows drift). Run `deleteStaleRemoteTrackingRefs` only when the refspec was actually narrowed
  in that call.
- **Acceptance**: Unit test: with `config --get-all remote.origin.fetch` returning the narrowed
  refspec and tagOpt '--no-tags', `runSyncAttempt` issues no `config --replace-all` and no
  `for-each-ref`; with a wide refspec it issues the two writes and the ref cleanup (existing tests
  'narrows an existing all-branches clone refspec' keep passing). Steady-state spawn count per tick
  asserted by counting `gitMock.raw`/`fetch` calls.
- **Notes**: Guards checked: No read-before-write and no memoisation exist; the comment at line
  882-884 justifies re-checking origin each tick but not rewriting config. Not described in
  CHANGELOG 5.2.0/5.3.1.

### [ ] T75. Stale remote-tracking refs are deleted one `git update-ref -d` process per ref instead of a single batched `update-ref --stdin`

- **Category**: performance · **Subsystem**: clone-sync
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/clone-sync.service.ts:403-427` (`deleteStaleRemoteTrackingRefs`),
  `src/services/clone-sync.service.ts:395-401` (`deleteRemoteTrackingRef`)
- **Current behavior**: After listing `refs/remotes/origin/*`, the code awaits `git update-ref -d
  <ref>` serially for each ref to delete. When a legacy all-branches clone is adopted (`git clone
  <url>` without --single-branch; e2e 'narrows legacy all-branches clone refspecs'), N = number of
  remote branches minus one; each deletion is a separate git process (~5 ms warm, more on
  Windows/antivirus hosts), serialised, inside the repo lock. Fetch `--prune` cannot remove them
  because the narrowed refspec no longer matches them. Failure scenario: Adopting an existing clone
  of a repo with 3,000 remote branches: ~3,000 serial git spawns (tens of seconds on Linux, minutes
  on Windows) during the first sync; the same cost recurs on every `checkoutBranch` that switches
  away from a wide-refspec state.
- **Expected behavior**: Delete in one process: pipe `delete <ref>\n` lines to `git update-ref
  --stdin` (best-effort, same swallow-on-error semantics), or `git for-each-ref --format='delete
  %(refname)' refs/remotes/origin | git update-ref --stdin` with the keep/HEAD refs filtered in JS.
- **Acceptance**: Unit test: for-each-ref returns 4 refs (HEAD, tracked, a, b) -> exactly one
  `update-ref --stdin` invocation whose stdin contains `delete refs/remotes/origin/a` and `delete
  refs/remotes/origin/b` and nothing for HEAD/tracked. Existing e2e 'narrows legacy all-branches
  clone refspecs and deletes stale remote refs' keeps passing.
- **Notes**: Guards checked: No batching exists; tests assert per-ref `update-ref -d` calls
  (checkoutBranch test lines 674-716), which pins the N+1 shape.

### [ ] T76. Clone-mode syncs produce no per-phase timing in --debug (PhaseTimer is only wired into the worktree-mode runner)

- **Category**: workflow · **Subsystem**: clone-sync
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/worktree-sync.service.ts:480-481, 506-514, 527-531`
  (`WorktreeSyncService.sync`), `src/services/clone-sync.service.ts:835-1017`
  (`CloneSyncService.runSyncAttempt`), `src/utils/timing.ts:91-118` (`formatTimingTable`)
- **Current behavior**: `sync()` creates a `PhaseTimer` but passes it only to
  `worktreeModeSyncRunner.runSyncAttempt`; `cloneSync.runSyncAttempt(outcome)` never receives it.
  With `debug: true` a clone-mode repo prints a 'Performance Summary' table containing only 'Total
  Sync', so a slow clone-mode tick (fetch vs status scan vs deepen vs merge — see the status and
  depth findings) cannot be attributed to a phase. Failure scenario: User enables `debug: true` to
  find out why a clone-mode repo takes 40 s per tick; the table shows 'Total Sync 40.2s' and nothing
  else; they have no way to see that 38 s were the `git status` scan or a deepen fetch.
- **Expected behavior**: Pass the PhaseTimer into `runSyncAttempt` (optional parameter) and bracket
  the phases: validate (HEAD/origin), unshallow, fetch, verify-ref, sparse, status, classify
  (+deepen count), merge. Emit the same table shape as worktree mode.
- **Acceptance**: worktree-sync.service test with a clone-mode config and `debug:true`:
  `logger.table` receives a table containing rows for 'fetch', 'status' and 'classify' (names as
  chosen) in addition to 'Total Sync'.
- **Notes**: Guards checked: Grep for `phaseTimer` shows it is only referenced in the worktree
  runner call (line 511); CloneSyncService has no timer parameter.

### [ ] T77. A detached-HEAD managed worktree is reported and counted as a freshly created worktree on every sync

- **Category**: correctness · **Subsystem**: git
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/git.service.ts:1490-1502` (`getWorktreesFromBare (excludes detached
  from inventory)`), `src/services/git.service.ts:565-575` (`addWorktree silent 'already exists'
  return`), `src/services/worktree-sync-planner.ts:57-62` (`planCreateActions`),
  `src/services/worktree-mode-sync-runner.ts:384-390` (`createNewWorktrees records created`)
- **Current behavior**: `getWorktrees()` drops detached worktrees, so the planner does not see the
  branch as existing and plans a create at the same sanitized path. `addWorktree` finds the path
  registered (it lists with `includeDetached=true`), returns silently, and the runner logs '✅
  Created worktree' and calls `outcome.recordCreated`. Failure scenario: User runs `git checkout
  <sha>` inside `feature-x-<hash>/` to inspect history. Every tick the log says 'Created worktree
  for feature-x' and the MCP/TUI outcome counts `created: 1`, while the directory stays detached and
  never updates.
- **Expected behavior**: `addWorktree` should return a discriminated result (`created` |
  `already_registered_detached` | …) or throw a typed error, and the runner should record a skip
  (`detached_worktree`) with the path instead of a creation.
- **Acceptance**: Runner test: inventory contains a detached registration at the sanitized path of
  remote branch `feature-x`; after sync, outcome has no `created` entry for it and has a skip naming
  the path; log does not contain 'Created worktree'.
- **Notes**: Guards checked: CHANGELOG 5.2.0 hardened removal of detached worktrees but not creation
  accounting; test 'treats a detached registration at the target path as occupied'
  (git.service.test.ts:891) only asserts no re-creation, not the outcome.

### [ ] T78. Dead and silently broken git wrappers: `localBranchExists` always returns true and `hasDivergedHistory` always returns false (simple-git swallows silent exit-1); several other exports are unused

- **Category**: correctness · **Subsystem**: git
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/git.service.ts:899-907` (`GitService.localBranchExists (show-ref
  --quiet)`), `src/services/git.service.ts:1196-1213` (`GitService.hasDivergedHistory (merge-base
  --is-ancestor)`), `src/services/git.service.ts:874-878, 1033-1040, 1083-1085, 1091-1095,
  1447-1451` (`pruneWorktrees, hasUnpushedCommits, hasUpstreamGone, hasModifiedSubmodules,
  getCurrentBranch, getLocalBranches (no callers)`), `src/services/path-resolution.service.ts:53-60,
  68-70` (`normalizeWorktreePath / extractBranchFromWorktreePath (no callers)`)
- **Current behavior**: simple-git treats a non-zero exit with empty stderr as success
  (`isTaskError` = exitCode && stdErr.length). `show-ref --verify --quiet` on a missing ref and
  `merge-base --is-ancestor` on a non-ancestor both exit 1 silently, so `localBranchExists` resolves
  to `true` for any name and `hasDivergedHistory` resolves to `false` for any history. Neither is
  called today (clone-sync has its own private `localBranchExists`), but both are public methods on
  the central service and read as correct; `pruneWorktrees` (global prune the runner deliberately
  avoids), `getCurrentBranch`, `getLocalBranches`, the three status wrappers and two
  PathResolutionService methods are also unreachable. Failure scenario: A future caller (e.g.
  restore or MCP) uses `localBranchExists(name)` to decide whether `createBranchAt` is safe → it
  always says the branch exists; or uses `hasDivergedHistory` as a safety gate → it always says 'can
  fast-forward'. `pruneWorktrees` if wired in would drop registrations on temporarily unmounted
  volumes (see runner comment at 563-566).
- **Expected behavior**: Delete the unused methods, or fix them: `show-ref --verify` without
  `--quiet` (as `branchExists` does), and replace `--is-ancestor` with `rev-list --count <a>..<b>`
  (as worktree-status.service.ts:272-275 already does). Add a lint rule/`knip` run for unused
  exports.
- **Acceptance**: `localBranchExists('nope')` returns false against a real repo;
  `hasDivergedHistory` returns true for a truly diverged worktree; or the methods are removed and
  `pnpm typecheck` passes. Unused-export check reports none of the listed symbols.
- **Notes**: Guards checked: The pitfall is documented next to `branchExists` (git.service.ts:1431)
  and in worktree-status.service.ts:273-274, but these two methods predate that and have no tests.
  Verified with simple-git 3.36 in scratch exp4.

### [ ] T79. F9(3) incomplete: `extractRepoNameFromUrl` still rejects URL shapes `isValidGitUrl` accepts (`git://`, https with trailing slash), and the validator rejects legal scp URLs with a non-`git` user

- **Category**: correctness · **Subsystem**: git
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/utils/git-url.ts:13-43` (`extractRepoNameFromUrl`),
  `src/services/config-loader.service.ts:767-777` (`ConfigLoaderService.isValidGitUrl`),
  `src/services/config-loader.service.ts:121-125, 646-649` (`validation message vs
  getDefaultBareRepoDir call`), `src/utils/git-url.ts:70` (`normalizeRepoUrlForComparison accepts
  any user@host: (inconsistent)`)
- **Current behavior**: `isValidGitUrl` accepts `git://…` and any `https?://…`;
  `extractRepoNameFromUrl` has no `git://` pattern and its https pattern cannot match a trailing
  slash, so a validator-blessed `repoUrl` without an explicit `bareRepoDir` fails at line 649 with
  'Invalid Git URL format'. Conversely `deploy@host:org/repo.git` (scp syntax with a non-`git` user,
  common on self-hosted Gitea/Gerrit) is rejected by the validator as 'invalid repoUrl' even though
  git accepts it and `normalizeRepoUrlForComparison` handles it. Failure scenario: `repoUrl:
  'https://github.com/acme/app.git/'` (copied with a trailing slash) or
  `'git://git.example.com/app.git'` → config load fails with the contradictory 'Invalid Git URL
  format' instead of the validation message; `repoUrl: 'gitea@git.example.com:team/app.git'` →
  rejected outright.
- **Expected behavior**: One URL grammar shared by validator and extractor: strip a trailing `/`
  before matching, add `git://`, accept `[\w.-]+@host:path` scp form. Validation and extraction must
  agree for every accepted shape.
- **Acceptance**: git-url tests: `extractRepoNameFromUrl` returns `repo` for `git://h/o/repo.git`,
  `https://h/o/repo.git/`, `deploy@h:o/repo.git`; config-loader test: each of those `repoUrl`s loads
  without `bareRepoDir` and resolves to `.bare/repo`.
- **Notes**: Re-verified: `extractRepoNameFromUrl` has no `git://` branch and its https regex
  requires a non-empty final segment, so `https://host/org/repo/` throws; `isValidGitUrl`
  (config-loader.service.ts:767-777) accepts both. Also reported as: “repoUrl grammar disagreement
  (F9 item 3 incomplete): `git://` URLs and trailing-slash URLs pass isValidGitUrl but worktree-mode
  bareRepoDir derivation throws 'Invalid Git URL format'; `user@host:path` scp URLs that git accepts
  are rejected outright”.

### [ ] T80. Sparse-checkout patterns are not validated at load time; cone-mode includes with a leading slash (or wildcards) are rejected by git, so every worktree creation fails and is rolled back on every tick

- **Category**: workflow · **Subsystem**: git
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/sparse-checkout.service.ts:69-80`
  (`SparseCheckoutService.applyToWorktree`), `src/services/config-loader.service.ts:470-510`
  (`validateSparseCheckoutConfig (type checks only)`), `src/services/git.service.ts:811-823`
  (`runSparseStepWithRollback`), `src/services/worktree-mode-sync-runner.ts:152-165`
  (`reapplySparseCheckout failure recording`)
- **Current behavior**: `validateSparseCheckoutConfig` only checks that `include` entries are
  non-empty strings. In cone mode git refuses `/apps/web` ('specify directories rather than patterns
  (no leading slash)') and glob characters. The failure surfaces only inside `addWorktree` as
  'Sparse-checkout setup failed' after the worktree was added and rolled back, and again in Step 5
  for every existing worktree, every tick. Failure scenario: gitignore-minded user writes
  `sparseCheckout: { include: ['/apps/web'] }`. Config loads fine; the first sync creates N
  worktrees and rolls each back, recording N `create_failed` entries, and repeats forever. The
  message does not say which pattern is wrong or that cone mode forbids a leading slash.
- **Expected behavior**: Validate cone-mode includes at load time (reject leading `/`, `*`, `?`,
  `[`, `!`, and `..` components) with a `ConfigError` naming the repo, pattern and rule, or
  normalise a leading slash away. Optionally run `git sparse-checkout check-rules`-style validation
  once per repo before creating worktrees.
- **Acceptance**: config-loader test: cone-mode include `/apps/web` (and `apps/*`) rejected with a
  message containing the pattern; `apps/web/` accepted. E2E: a config with a leading-slash cone
  include never issues `worktree add`.
- **Notes**: Re-verified: `validateSparseCheckoutConfig` (config-loader.service.ts:470-510) checks
  only types and emptiness; git rejects cone-mode patterns with a leading `/` or wildcards at
  `sparse-checkout set` time (sparse-checkout.service.ts:69-80), which runs inside every worktree
  creation.

### [ ] T81. An interrupted bare clone (SIGKILL/power loss) leaves a HEAD-less bareRepoDir that makes every later initialize fail with git's 'destination path already exists' and no recovery path

- **Category**: guardrail · **Subsystem**: git
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/git.service.ts:115-128` (`GitService.initialize (exists check = HEAD
  file; clone into existing dir)`), `src/services/clone-sync.service.ts:763-795`
  (`maybeCleanupPartialClone (clone mode has a marker-based recovery; worktree mode has none)`)
- **Current behavior**: 'Bare repo exists' is decided by `fs.access(<bare>/HEAD)`. A clone killed
  with SIGKILL (OOM, power loss; git's own junk cleanup only runs on SIGINT/SIGTERM/exit) leaves
  objects/ and config but no HEAD. The next `initialize` runs `git clone --bare <url> <bare>` again,
  which refuses because the destination is a non-empty directory; there is no marker, no cleanup and
  no hint. Failure scenario: Daemon OOM-killed during the initial multi-GB bare clone. Every
  subsequent run logs `fatal: destination path '.bare/repo' already exists and is not an empty
  directory` until the user deletes the directory manually.
- **Expected behavior**: Write a `.sync-worktrees-clone-init.pending` style marker before cloning
  (as clone mode does) and, on the next initialize, remove a marker-bearing HEAD-less directory
  (never one without the marker) before retrying; otherwise fail with an actionable message naming
  the directory.
- **Acceptance**: Unit test: bareRepoDir exists, contains the pending marker and no HEAD ⇒ directory
  removed and clone re-issued; exists without marker and no HEAD ⇒ error mentions the path and how
  to recover; existing HEAD ⇒ no clone.
- **Notes**: Guards checked: Round-1 #33/#36/#49 cover the clone-mode marker; worktree mode never
  got the equivalent. simple-git's own timeout kills with SIGINT (index.js:1423), which git cleans
  up, so only hard kills reach this state.

### [ ] T82. Compare-and-swap branch deletion (`update-ref -d`) leaves the `[branch "<name>"]` remote/merge section in the bare repo config for every trashed worktree, growing .bare/config without bound

- **Category**: performance · **Subsystem**: trash
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/git.service.ts:928-934` (`GitService.deleteLocalBranchIfAt`),
  `src/services/trash.service.ts:471-482` (`TrashService.deleteTrashedBranchRef`)
- **Current behavior**: Every trash removal of a branch worktree deletes the local branch with `git
  update-ref -d refs/heads/<b> <oid>` (the CAS path is taken whenever headOid is known, i.e. always
  when a pin exists). Unlike `git branch -D`, `update-ref -d` does not remove `branch.<b>.remote` /
  `branch.<b>.merge`, so each pruned branch leaves a 3-line dead section in `<bare>/config`.
  Sections are only reused if the same branch name is re-created. Failure scenario: Team prunes ~50
  merged branches/week. After a year `.bare/config` holds ~2600 dead `[branch ...]` sections (~8k
  lines). Every git spawn (round-1 #1 counts ~6 per worktree per tick) parses this config; `git
  config --list` and TUI/manual inspection are cluttered; a later `git branch <b> <sha>` (restore)
  silently inherits the stale upstream.
- **Expected behavior**: After a successful CAS delete, remove the branch's config section (`git
  config --remove-section branch.<b>`, tolerating 'no such section'), or perform the deletion with
  `git branch -D` guarded by a preceding CAS check inside the same lock. Optionally a maintenance
  step prunes `branch.*` sections whose ref no longer exists.
- **Acceptance**: Integration test with a real bare repo: set `branch.x.remote/merge`,
  trash-and-unregister worktree for x, assert `git config --get-regexp '^branch\.x\.'` is empty;
  existing CAS-refusal test still leaves the section intact. Verified empirically (git 2.43):
  `update-ref -d refs/heads/feat <sha>` left `branch.feat.remote/merge` in place while `branch -D
  feat2` removed `branch.feat2.*`.
- **Notes**: Guards checked: The CAS delete was introduced for race safety (5.3.1) and replaced
  `branch -D` on the common path; nothing else cleans config sections. No test asserts config state
  after trashing.

### [ ] T83. Legacy `.diverged/` adoption ignores the entry's `keep/<name>` ref: the permanent keep ref stays after the directory is moved into trash, and the payload's .diverged-info.json still points at a recovery flow that no longer applies

- **Category**: correctness · **Subsystem**: trash
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/trash-migration.service.ts:14-19, 80-129` (`DivergedInfo /
  migrateDivergedDir`), `src/services/worktree-mode-sync-runner.ts:1104-1109, 1121`
  (`divergeWorktree keepRef + writeDivergedInfoFile`),
  `src/services/worktree-sync.service.ts:228-263, 271-290` (`forceClean keep-ref retention`)
- **Current behavior**: The trash-disabled diverge flow mints
  `refs/sync-worktrees/keep/<divergedName>` and records `keepRef` in `.diverged-info.json`. When
  trash is later enabled, `migrateDivergedDir` adopts the directory as a keepPinOnReap trash entry
  (new pin + bundle) but never reads `keepRef`, so the old keep ref is left behind with nothing
  referencing it. The reaper later mints a second permanent ref `keep/<trashId>` for the same
  commit, and the payload's info file still instructs 'use the TUI worktree status view so the keep
  ref is released safely' (that view no longer lists the entry). Force clean deletes the orphaned
  legacy keep ref only because no `.diverged/` dir matches — otherwise nothing ever does. Failure
  scenario: User ran with trash disabled, got `.diverged/2026-06-02-feat-abc12` +
  `keep/2026-06-02-feat-abc12`. Enables trash. Next sync adopts the dir. `sync-worktrees trash` now
  lists the entry AND `KEEP 2026-06-02-feat-abc12`; after 30 days it also lists `KEEP <trashId>` —
  two permanent refs for one commit, and the user must `--dropKeepRef` each with typed confirmation.
- **Expected behavior**: Adoption reads `info.keepRef`; after the trash entry (pin + bundle) is
  created successfully, delete the legacy keep ref (validated against `KEEP_REF_PREFIX + name` like
  discardDivergedDirectory does) or record it in the manifest so reap/purge release it. Rewrite the
  copied .diverged-info.json's instruction/keepRef to the trash flow.
- **Acceptance**: Migration test: `.diverged/<name>/.diverged-info.json` with `keepRef:
  'refs/sync-worktrees/keep/<name>'` -> after migrateLegacyUnlocked, `deleteRef` was called with
  that keep ref exactly once and only after `updateRef(pinRef)` succeeded; an adoption that fails
  (pin fails) leaves the keep ref. Existing tests unchanged.
- **Notes**: Re-verified: `DivergedInfo` (trash-migration.service.ts:14-19) has no `keepRef` field
  and `migrateDivergedDir` never deletes the `refs/sync-worktrees/keep/<name>` ref written by
  `divergeWorktree` (worktree-mode-sync-runner.ts:1111-1113).

### [ ] T84. Force clean runs `git gc --prune=now` on a shared object store without checking for in-flight git operations, while the modal text says active worktrees are untouched

- **Category**: guardrail · **Subsystem**: trash
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/services/worktree-sync.service.ts:264-266` (`forceClean ->
  maintenanceService.runNowUnlocked`), `src/services/git-maintenance.service.ts:170-177`
  (`runUnlocked args gc --prune=now`), `src/components/ForceCleanModal.tsx:82-83`, `README.md:484,
  564`
- **Current behavior**: `runNowUnlocked` always forces `git gc --prune=now` in the bare repo shared
  by every worktree. The repo lock only serializes sync-worktrees' own operations; git's
  documentation states `--prune=now` 'increases the risk of corruption if another process is writing
  to the repository concurrently'. README line 484 documents exactly that caveat for
  `maintenance.aggressive`, but the force-clean modal (the interactive, explicitly-confirmed path)
  says 'Active worktrees are not synced, changed, or removed' and never warns, and no check for
  `<bare>/worktrees/*/index.lock`, `<bare>/*.lock` or `MERGE_HEAD`/`rebase-merge` is made before
  pruning. Failure scenario: Developer runs `git add -A && git commit` in a worktree (loose
  blobs/tree written, ref not yet updated) at the moment the admin confirms force clean in the TUI;
  prune deletes the not-yet-referenced loose objects; the commit fails with 'unable to read <sha>' /
  corrupt index and must be redone; an IDE auto-staging in the background hits the same window.
- **Expected behavior**: Before gc: probe each registered worktree's admin dir for `index.lock` and
  operation files (the status service already knows these) and refuse or warn when found; use
  `--prune=<grace>` (e.g. `--prune=1.hour.ago`, still reclaiming the just-purged trash objects,
  which are older) unless the user opts into `now`; and word the modal to match README 484 ('do not
  run while git commands are active in any worktree of these repositories').
- **Acceptance**: Unit test: forceClean with a mocked worktree list where one worktree has
  `index.lock` -> gc is not run and the result carries an error naming the worktree; without locks
  gc runs. Modal snapshot updated. README 564 mentions the concurrency caveat.
- **Notes**: Guards checked: The maintainers documented the hazard for `aggressive` (README 484) but
  the force-clean UI copy contradicts it and there is no runtime probe; tests mock `runNowUnlocked`.

### [ ] T85. Manifest `branch` is not validated as a ref name; a hand-edited or corrupted manifest with an option-like branch makes restore run `git branch -m <sha>` and rename the bare repo's HEAD branch

- **Category**: guardrail · **Subsystem**: trash
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/trash.service.ts:585-632` (`TrashService.readManifest (branch check at
  599)`), `src/services/trash.service.ts:492-541` (`restoreAsWorktree`),
  `src/services/git.service.ts:918-926, 953-959` (`createBranchAt / deleteLocalBranch /
  addWorktreeNoCheckout`)
- **Current behavior**: `readManifest` guards pinRef shape carefully (comment at 634-638: 'a
  hand-edited manifest can never aim the reaper's deleteRef at refs/heads/main') but accepts any
  string for `branch`. `createBranchAt(branch, sha)` runs `git branch <branch> <sha>` with the
  branch first, `deleteLocalBranch` runs `git branch -D <branch>`, and `addWorktreeNoCheckout` puts
  the branch last, all without `--`. Real branch names cannot start with `-`, so only a
  tampered/corrupted manifest reaches this, but the code's own threat model already includes
  hand-edited manifests. Failure scenario: manifest.json edited to `branch: "-m"` (headOid/pinRef
  intact). `sync-worktrees trash --restore <id>`: `getLocalBranchCommit('-m')` -> null,
  `createBranchAt('-m', <sha>)` -> `git branch -m <sha>` renames the bare repo's current branch
  (main) to `<sha>`; worktree add then fails and rollback `git branch -D -m` errors. Every later
  sync fails to find `main`.
- **Expected behavior**: `readManifest` rejects `branch` values that are not valid ref names (no
  leading `-`, no `..`, `@{`, control chars, trailing `.lock`, etc. — or shell out to `git
  check-ref-format --branch` lazily at restore), and the git wrappers pass `--` before positional
  ref/path arguments where git supports it (`branch -- <name> <sha>`, `branch -D -- <name>`,
  `worktree add --no-checkout -- <path> <branch>`).
- **Acceptance**: Unit test: manifest with `branch: '-m'` (and '--delete', 'a..b') is reported in
  `invalid`; restore never calls createBranchAt. Verified empirically (git 2.43): in a bare repo
  with HEAD -> main, `git branch -m <sha>` renamed refs/heads/main to refs/heads/<sha>.
- **Notes**: Re-verified: `readManifest` only type-checks `branch` as string-or-null
  (trash.service.ts:599); `restoreAsWorktree` passes it positionally to `git branch <branch> <sha>`
  and `git worktree add --no-checkout <path> <branch>` (492-511, git.service.ts:918-921, 953-958)
  without `--` or `check-ref-format`.

### [ ] T86. Permanent keep refs accumulate one per squash-merged branch with no expiry, no batch removal, and O(N) fsync'd audit writes + git spawns in force clean

- **Category**: workflow · **Subsystem**: trash
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/services/worktree-status.service.ts:176, 197-203`
  (`fullyPushedUpstreamDeleted`), `src/services/worktree-mode-sync-runner.ts:580-585` (`prune ->
  keepPinOnReap`), `src/services/trash-reaper.service.ts:99-115, 168-172` (`keep ref creation on
  reap`), `src/services/worktree-sync.service.ts:241-262, 332-344` (`forceClean keep-ref loop /
  deleteKeepRef`), `src/index.ts:255-274` (`runTrash --dropKeepRef`)
- **Current behavior**: `fullyPushedUpstreamDeleted` is true exactly for the
  squash-merge-then-delete case (HEAD commits absent from every remote ref but HEAD equals the
  recorded upstream tip). Such prunes set `keepPinOnReap`, so 30 days later the reaper mints
  `refs/sync-worktrees/keep/<id>` permanently. For teams that squash-merge every PR this is every
  pruned branch. The only removal paths are `--dropKeepRef <name>` (one ref per invocation, TTY +
  typed confirmation) or force clean (all refs, plus all trash). Force clean deletes refs one by
  one: 2 fsync'd audit records + 1 `git update-ref -d` process per ref (cf. round-1 #44 for the
  batched `update-ref --stdin` pattern). Failure scenario: Squash-merge team, ~40 PRs/week: after a
  year ~2000 permanent keep refs. `sync-worktrees trash` output is 2000 KEEP lines; dropping them
  individually is impractical; force clean spends ~4000 fsyncs and 2000 git spawns under the lock
  (tens of seconds) and is all-or-nothing.
- **Expected behavior**: At reap time re-evaluate necessity: if `rev-list --count <headOid> --not
  --remotes` is 0 (commits reached the remote since) skip the keep ref; document/offer
  `trash.keepRefRetention` (or `never`), a `--dropKeepRefs --older-than <days>` / `--all` batch CLI
  with one confirmation, and batch deletions with `git update-ref --stdin` + one audit record
  listing the refs.
- **Acceptance**: Reaper test: keepPinOnReap entry whose commit is now on a remote (mock rev-list
  count 0) is reaped without creating a keep ref; otherwise keep ref created as today. CLI test for
  the batch drop flag. forceClean test asserting a single update-ref --stdin invocation for N refs.
- **Notes**: Guards checked: The permanent-keep policy is deliberate for never-pushed commits (5.0.0
  changelog), but no re-check, expiry, or batch tooling exists; tests cover single-ref deletion
  only.

### [ ] T87. Worktree restore copies the whole payload (fs.cp) and then rm's the container instead of renaming it into place — O(size) I/O and 2x disk during restore

- **Category**: performance · **Subsystem**: trash
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/trash.service.ts:510-513, 543-551` (`restoreAsWorktree /
  copyPayloadOver`), `src/services/trash.service.ts:428-434` (`restore container rm`),
  `src/services/git.service.ts:953-959` (`addWorktreeNoCheckout`)
- **Current behavior**: `restoreAsWorktree` runs `worktree add --no-checkout` (which creates the
  directory with only a `.git` file), then `fs.cp(payload -> dest, {recursive, force})` copying
  every file (node_modules, build output), then `fs.rm(container)` deleting every file again.
  Trashing used a single rename. Restore of a 2 GB / 200k-file payload therefore costs minutes of
  I/O under the repo lock and temporarily doubles disk, and inherits fs.cp's symlink rewriting
  (round-1 #21). Failure scenario: `sync-worktrees trash --restore <id>` for a monorepo worktree
  with node_modules: several minutes, lock held (daemon syncs skip with 'locked'), disk must have
  free space equal to the payload.
- **Expected behavior**: Register with `--no-checkout`, read the freshly written `.git` file, remove
  the fresh (near-empty) directory, `fs.rename(payloadPath, originalPath)`, rewrite the `.git` file,
  then `git reset`. Fall back to cp only on EXDEV. Same effect as the README's manual recipe, in
  O(1).
- **Acceptance**: Unit test: restore performs `fs.rename` of payload (spy) and no `fs.cp` in the
  same-device case; `.git` at destination equals the content written by addWorktreeNoCheckout;
  payload gone. Existing restore tests keep passing.
- **Notes**: Re-verified: `copyPayloadOver` uses `fs.cp` (trash.service.ts:545-551) after
  `addWorktreeNoCheckout`, then the container is removed; a rename of `payload/` over the registered
  path (with the fresh `.git` link written back) would be O(1).

### [ ] T88. TUI runs `du` over every bare repo and every worktreeDir after every sync cycle (and on each status view open), a full-tree stat walk per tick that is never cached or throttled

- **Category**: performance · **Subsystem**: trash
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/InteractiveUIService.tsx:966-975, 416-428` (`recordSyncOutcome ->
  calculateAndUpdateDiskSpace`), `src/utils/disk-space.ts:9-23, 51-76` (`calculateDirectorySize /
  calculateSyncDiskSpace`), `src/services/InteractiveUIService.tsx:444-470`
  (`getRepositoryDiskUsage`)
- **Current behavior**: `recordSyncOutcome` awaits `calculateSyncDiskSpace` after every non-skipped
  cycle; it spawns `sh -c 'du -sb .'` sequentially for each bare repo and each worktreeDir (2R
  processes), each walking the entire tree. `du` stats every file (node_modules, build caches) in
  every worktree; the result is only the header's total. The worktree status view repeats the walk
  per repo on open. Nothing caches by mtime or debounces. Failure scenario: 3 repos, 40 worktrees
  each with node_modules (~100k files) -> ~12M stat calls per hourly tick, sustained disk I/O
  competing with developers' builds; on network/overlay filesystems this takes minutes and the
  header value lags a full cycle.
- **Expected behavior**: Compute disk usage lazily (on `w`/explicit key) or at most once per
  configurable interval; reuse trash manifests' sizeBytes for the trash portion; run the per-repo
  `du` invocations in parallel bounded by maxParallel; consider `--apparent-size`/-x flags and
  skipping `.trash` when already known.
- **Acceptance**: Test: two consecutive sync cycles within the throttle window call fastFolderSize
  once; explicit refresh forces recompute. Manual: hourly daemon shows no `du` processes at each
  tick.
- **Notes**: Reported independently by the trash, TUI and process reviewers.
  `calculateAndUpdateDiskSpace` runs at startup, after every non-skipped sync cycle and after force
  clean; `getRepositoryDiskUsage` runs again per repo when the status view opens. Also reported as:
  “`du` over the entire workspace runs after every sync cycle (serially, before the UI returns to
  idle) and again for every repo each time the status view opens — no cache, no TTL, node_modules
  included”; “TUI recomputes total disk usage with `du` over every bare repo and every worktreeDir
  (node_modules included) after every sync cycle and force clean, serially, even when the cycle
  changed nothing”.

### [ ] T89. `sync-worktrees trash` CLI ergonomics: no size/branch/restorable columns, silent on empty trash, expected errors print as 'Unhandled error' stack traces, restore fails fast when the daemon holds the lock, no single-entry purge, and a files-only restore is silently re-trashed by the next sync

- **Category**: workflow · **Subsystem**: trash
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/index.ts:241-275, 386-390` (`runTrash / main().catch`),
  `src/services/trash.service.ts:417-426` (`restore files-only branch`),
  `src/services/repo-operation-lock.ts:92-98, 111-115` (`lockPath retries: 0`),
  `src/services/worktree-sync.service.ts:188-201` (`restoreFromTrash`), `README.md:566-583`
- **Current behavior**: (1) Listing prints `id\treason\texpiresAt\toriginalPath` only — no branch,
  size, keepPinOnReap/never-pushed marker, or whether restore will rebuild a worktree vs files only;
  empty trash prints nothing; no `--json`. (2) `runTrash` throws TrashOperationError/Error straight
  to `main().catch`, so 'no trash entry with id', 'destination already exists', 'another process
  holds the repo lock' all render as '❌ Unhandled error:' plus a stack. (3) `restoreFromTrash` uses
  wait:true on the in-process mutex, but the cross-process lock uses `retries: 0`, so a restore
  while the daemon is mid-sync fails immediately instead of waiting. (4) There is no way to delete
  one trash entry; README tells users to `rm -rf <id>` and `update-ref -d` by hand. (5) A pinless
  entry for a still-managed branch restores as files only (warning at :421) and the next sync's
  stale-directory handling moves it back into trash as a new 'orphan' entry, which the warning does
  not mention. Failure scenario: User runs `sync-worktrees trash -f repo --restore 2026-…` while the
  hourly sync is running: output is a stack trace ending in 'another process holds the repo lock';
  retries a minute later; then wants to discard one 3 GB entry early and has to follow the manual
  rm/update-ref recipe.
- **Expected behavior**: Print a table (id, branch, reason, size, expires, restorable-as-worktree,
  never-pushed) and an explicit 'trash is empty' line; add `--json`; catch TrashOperationError/Error
  in runTrash and print `❌ <message>` with exit code 1; add `--wait` (or default) that retries the
  cross-process lock for the restore path; add `--purge <id>` (audit-gated, deletes pin, honours
  keepPinOnReap by minting the keep ref); make the files-only warning say the directory will be
  re-trashed if the branch is still synced.
- **Acceptance**: trash-cli tests: empty list prints 'No trash entries'; a rejected restore prints a
  one-line error and sets exitCode 1 without a stack; `--purge <id>` calls a new `purgeEntry(id)`
  through the lock; `--json` output parses.
- **Notes**: Guards checked: CLI tests mock the service and only cover dispatch; README documents
  the manual recipe instead of a command.

### [ ] T90. No real-git coverage for trash restore or force clean: restoreAsWorktree, legacy-manifest compatibility and purge are only exercised with stubbed GitService / mocked purgeAllUnlocked

- **Category**: testing · **Subsystem**: trash
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/services/__tests__/trash.service.test.ts:18-31, 448-471` (`makeGitStub /
  restore tests`), `src/services/__tests__/worktree-sync.service.test.ts:249-260, 280-298, 310-325`
  (`forceClean tests (purgeAllUnlocked mocked)`),
  `src/__tests__/e2e/diverged-branch-reservation.test.ts:99-110`,
  `src/services/__tests__/trash-reaper.service.test.ts:93-135`
- **Current behavior**: Every restore test stubs
  createBranchAt/addWorktreeNoCheckout/resetWorktreeIndex, so the actual sequence (`git branch <b>
  <sha>`, `git worktree add --no-checkout`, overlay, `git reset`, sparse re-apply, upstream state)
  never runs against git. The only e2e touching `.trash` reads manifests. forceClean tests mock
  `purgeAllUnlocked`, so purge + keep-ref deletion + `gc --prune=now` interplay (pins deleted before
  gc, retained keep refs surviving gc) is untested end to end. No test writes a pre-5.1.1 manifest,
  a partially deleted container, or an option-like branch name. Failure scenario: A regression in
  addWorktreeNoCheckout argument order, in the .git-link filter, or in pin/keep ordering before gc
  would pass the suite while restore or force clean silently destroys or fails to rebuild worktrees.
- **Expected behavior**: Add an e2e test (local git, like the existing e2e suite) that: trashes a
  worktree with an uncommitted file, restores it, asserts it is registered (`git worktree list`), on
  the right commit, with the file present as an unstaged change; and a force-clean e2e that trashes
  an entry with never-pushed commits, runs forceClean, and asserts the objects are gone while a
  `.diverged/`-backed keep ref survives gc. Add unit fixtures for legacy manifests, partial rm, and
  invalid branch strings.
- **Acceptance**: New tests under src/__tests__/e2e/ pass with `pnpm test:e2e:local`; unit fixtures
  added to trash.service.test.ts and trash-reaper.service.test.ts; coverage thresholds unchanged or
  higher.
- **Notes**: Guards checked: Existing tests target service logic with stubs; e2e directory contains
  only the reservation scenario for trash.

### [ ] T91. Load-time validation gaps with runtime consequences: `branchInclude: [""]` prunes every non-default worktree, NaN/Infinity retry numbers pass and make retry() throw, `skipUpdateWhenOutsideSparse` accepts a string that inverts its meaning

- **Category**: guardrail · **Subsystem**: config
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/config-loader.service.ts:303-308` (`validateBranchPatternList (allows
  empty strings)`), `src/services/config-loader.service.ts:366-411` (`validateRetryConfig (no
  Number.isFinite)`), `src/services/config-loader.service.ts:471-510` (`validateSparseCheckoutConfig
  (skipUpdateWhenOutsideSparse unchecked)`), `src/utils/branch-filter.ts:136-157` (`matchesPattern /
  filterBranchesByName`), `src/utils/retry.ts:78-80, 123-132`,
  `src/services/worktree-mode-sync-runner.ts:828` (`sparseCfg.skipUpdateWhenOutsideSparse !==
  false`)
- **Current behavior**: (1) Empty/whitespace patterns are accepted; `[""]` has length 1 so
  filterBranchesByName filters to branches whose name === '' — none — and the sync treats every
  existing non-default worktree as unmanaged and prunes it to trash. (2) validateRetryConfig uses `<
  0` / `< 1` comparisons that NaN and Infinity pass; retry() then throws 'maxAttempts must be
  'unlimited' or a finite positive number' on every sync for NaN maxAttempts, and NaN delays produce
  zero-delay hot retries. (3) `skipUpdateWhenOutsideSparse: "false"` is accepted; the runner
  compares `!== false`, so the string enables skipping instead of disabling it. Depth and trash
  validation already use Number.isSafeInteger/isFinite, so this is an inconsistency rather than a
  policy choice. Failure scenario: (1) `branchInclude: (process.env.BRANCHES ?? '').split(',')` with
  BRANCHES unset yields `['']`; the next sync logs pruning of every feature worktree (recoverable
  from trash for retentionDays, but all of them move at once and the user must restore each). (2)
  `retry: { maxAttempts: Number(process.env.RETRIES) }` with the variable unset → every sync rejects
  with the retry() error although `list` reported the config valid. (3)
  `skipUpdateWhenOutsideSparse: "false"` → HEAD is never advanced for changes outside the sparse
  set, the opposite of what was written.
- **Expected behavior**: validateBranchPatternList rejects empty/whitespace-only patterns;
  validateRetryConfig requires Number.isFinite for every numeric field (and Number.isSafeInteger for
  maxAttempts/maxLfsRetries); validateSparseCheckoutConfig type-checks skipUpdateWhenOutsideSparse
  as boolean; all with ConfigValidationError naming repo and field.
- **Acceptance**: Loader tests: `branchInclude: ['']`, `branchExclude: [' ']` → rejected;
  `retry.maxAttempts: NaN`, `retry.initialDelayMs: Infinity`, `retry.backoffMultiplier: NaN` →
  rejected; `sparseCheckout.skipUpdateWhenOutsideSparse: 'false'` → rejected; existing valid shapes
  still pass.
- **Notes**: Re-verified: `validateBranchPatternList` (config-loader.service.ts:303-308) accepts
  empty strings; `validateRetryConfig` (362-411) uses `< 1` / `< 0` comparisons that `NaN` passes
  because `typeof NaN === "number"`.

### [ ] T92. Unknown / misspelled config keys are silently ignored at runtime (typo'd `updateExistingWorktree`, `branchIncludes`, `fetchTimeoutMs` load without a warning)

- **Category**: workflow · **Subsystem**: config
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/services/config-loader.service.ts:101-184, 188-247` (`validateConfigFile
  (allowlist checks only)`), `src/services/config-loader.service.ts:612-723`
  (`resolveRepositoryConfig (drops unlisted keys)`), `src/utils/config-generator.ts:138-148`
  (`generated `// @ts-check` + @satisfies header`)
- **Current behavior**: Validation only inspects known keys; any other key on a repository, on
  `defaults`, or at the top level is accepted and then dropped by resolveRepositoryConfig. The
  generated config relies on `// @ts-check` + `@satisfies` for excess-property errors, which only
  fire inside a TypeScript-aware editor and never at load time. The CLI itself is strict about
  unknown flags (cli.ts `.strict()`), so the two surfaces behave inconsistently. Failure scenario: A
  user writes `updateExistingWorktree: false` (missing 's') to freeze a reference checkout; the
  loader accepts it, the option is discarded, and the worktree keeps being fast-forwarded on every
  tick with no indication anything was ignored. Same for `branchIncludes`, `sparseCheckOut`,
  `retries`, `maxAge`.
- **Expected behavior**: After known-key validation, compute the set of unrecognised keys per
  repository/defaults/top level and emit a warning through the logger ('Repository 'x': unknown
  option 'updateExistingWorktree' ignored (did you mean 'updateExistingWorktrees'?)'), or reject
  them under a strict mode. Suggestions can use a simple Levenshtein match against the known key
  list.
- **Acceptance**: Loader test: repository with `updateExistingWorktree: false` loads and the
  injected logger/console.warn receives a message naming the repo and the unknown key with the
  suggestion; a known-key-only config produces no warning; `list` output shows the warning once.
- **Notes**: Guards checked: The validator is written as positive checks on expected keys and has no
  key inventory; @ts-check is editor-only.

### [ ] T93. CLI error reporting loses context: init failures omit the repository name, every runtime error is labelled 'Error loading config file', `trash` errors dump a raw stack, and config SyntaxErrors lack file/line

- **Category**: workflow · **Subsystem**: config
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/index.ts:86-93` (`runMultipleRepositories init failure log`),
  `src/index.ts:332-347` (`runSync catch`), `src/index.ts:241-275, 360-363` (`runTrash (no error
  handling)`), `bin/sync-worktrees.js:8-11`, `src/services/config-loader.service.ts:76-81`
  (`loadConfigFile error wrapping`)
- **Current behavior**: (1) After Promise.allSettled, a rejected initialize is logged as '❌ Failed
  to initialize repository: <reason>' by the global logger; the per-repo header lines were printed
  earlier and interleave under parallelism, so with N repos the user cannot tell which one failed
  (the index i ↔ repositories[i] mapping is available). (2) runSync wraps the whole run; any error
  escaping runMultipleRepositories in daemon mode (e.g. a WorktreeSyncService constructor throwing
  on a Windows-reserved `name`, or an Ink render error) is printed as '❌ Error loading config file:
  ...'. (3) runTrash has no try/catch, so expected user errors ('Trash operations require exactly
  one repository', 'no trash entry with id', ConfigFileNotFoundError) reach bin's handler and print
  '❌ Unhandled error:' followed by a full stack trace. (4) A syntax error in the config surfaces as
  'Failed to load config file: Unexpected token ']'' — the file path and line that Node puts in
  error.stack are discarded. Failure scenario: `sync-worktrees --runOnce` with 6 repos where one
  bare clone fails: output shows six '📦 Repository:' headers interleaved, then a single '❌ Failed
  to initialize repository: fatal: could not read Username for ...' with no repo name.
  `sync-worktrees trash` with a two-repo config and no --filter prints an 'Unhandled error' stack
  trace for a usage mistake. A missing comma in the config prints 'Unexpected token' without a line
  number.
- **Expected behavior**: Log init failures as '❌ Failed to initialize repository '<name>': <msg>'
  using the index into `repositories`; in runSync distinguish config-load errors (ConfigError /
  thrown from buildRepositories) from run errors; give runTrash the same friendly catch as runList
  (message only, exit 1); for SyntaxError/ReferenceError during import, include the first stack line
  (file:line:col) in the thrown message.
- **Acceptance**: index.run-once.test: init rejection for repo-b produces a log line containing
  'repo-b'; cli/index test: `trash` with a 2-repo config exits 1 with a one-line message and no
  stack; loader test: a config with a syntax error yields a message containing the config path and a
  line number.
- **Notes**: Guards checked: runList has the friendly catch but runTrash was added later without
  one; the init failure line predates multi-repo parallel init; no tests cover these outputs.

### [ ] T94. Docs drift in shipped user-facing text: example config's lock-file location is wrong, README's CLI section omits the `trash` subcommand

- **Category**: docs · **Subsystem**: config
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `sync-worktrees.config.example.js:297-298`, `src/utils/lock-path.ts:101-117`
  (`getWorktreeDirLockTarget`), `README.md:623-637`, `src/utils/cli.ts:101-124` (`trash command`)
- **Current behavior**: The example config states the clone-mode lock lives at
  `<configDir>/.sync-worktrees-state/<sanitized-name>-<hash>.lock` ('never inside the cloned repo,
  so no .gitignore noise'); since the 5.3.1 lock rework the lock is keyed by canonical worktreeDir
  under `$XDG_STATE_HOME` or `~/.cache/sync-worktrees/locks/<hash>.lock` (lock-path.ts:108-117);
  only the removal audit log still uses `.sync-worktrees-state`. README's 'CLI options' section
  lists only `init` and `list` under Subcommands and no `trash` row in the option table, although
  `trash --filter/--restore/--dropKeepRef` exists (cli.ts 101-124) and is referenced earlier in the
  Trash section. Failure scenario: An operator debugging 'another process holds the lock' looks for
  the lock file under `<configDir>/.sync-worktrees-state/` as documented, finds only
  `*-removals.jsonl`, and cannot locate or clear the stale lock; a user reading the CLI reference
  does not discover `trash` and restores by hand.
- **Expected behavior**: Update the example comment to the real path (and mention XDG_STATE_HOME);
  add `sync-worktrees trash [--config] --filter <name> [--restore <id> | --dropKeepRef <name>]` to
  README's Subcommands list and mention it requires exactly one matched repository and a TTY for
  --dropKeepRef.
- **Acceptance**: Text review: example comment matches lock-path.ts; README Subcommands lists trash
  with the three flags; a doc-lint grep in CI for '.sync-worktrees-state/.*\.lock' returns nothing.
- **Notes**: Guards checked: Docs were not updated when the lock target moved in 5.3.1 and when the
  trash CLI was added in 5.2.0.

### [ ] T95. Dead or duplicated constants in src/constants.ts: unused GIT_CONSTANTS/DEFAULT_CONFIG/METADATA entries, FETCH_CONFIG duplicated as a literal in git.service.ts, test-only TEST_TIMEOUT shipped in dist, unused CliCommand type

- **Category**: workflow · **Subsystem**: config
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/constants.ts:4, 21, 23, 39-44, 55, 91-94, 104, 135-137` (`HEAD_REF,
  REFS.REMOTES_ORIGIN, FETCH_CONFIG,
  RETRY.MAX_ATTEMPTS/MAX_LFS_RETRIES/BACKOFF_MULTIPLIER/JITTER_MS, UPDATE_EXISTING_WORKTREES,
  TEST_TIMEOUT, PATH_CONSTANTS.README, METADATA_CONSTANTS.ACTION_*`),
  `src/services/git.service.ts:136` (`targetConfig literal "+refs/heads/*:refs/remotes/origin/*"`),
  `src/services/sync-retry-policy.ts:29-34` (`hard-coded retry defaults`), `src/utils/cli.ts:11`
  (`CliCommand`)
- **Current behavior**: A grep of non-test sources shows zero uses of GIT_CONSTANTS.HEAD_REF,
  REFS.REMOTES_ORIGIN, FETCH_CONFIG, DEFAULT_CONFIG.UPDATE_EXISTING_WORKTREES, TEST_TIMEOUT,
  PATH_CONSTANTS.README, METADATA_CONSTANTS.ACTION_CREATED/UPDATED/FETCHED,
  DEFAULT_CONFIG.RETRY.MAX_ATTEMPTS/MAX_LFS_RETRIES/BACKOFF_MULTIPLIER/JITTER_MS and the exported
  CliCommand type. git.service.ts:136 re-types the fetch refspec instead of using FETCH_CONFIG, and
  SyncRetryPolicy hard-codes 3/2/1000/30000/2/0 while validateRetryConfig compares against
  DEFAULT_CONFIG.RETRY.* — two sources of truth for the same defaults (round-1 #16/#26 flagged only
  the jitter mismatch and README text). Failure scenario: A maintainer changes
  DEFAULT_CONFIG.RETRY.MAX_ATTEMPTS expecting the sync retry budget to change; nothing changes
  because sync-retry-policy.ts ignores the constant. A maintainer changes FETCH_CONFIG for a mirror
  refspec; the bare-repo config written at git.service.ts:136 stays on the literal.
- **Expected behavior**: Delete unused exports (or move TEST_TIMEOUT to a test helper); make
  SyncRetryPolicy read DEFAULT_CONFIG.RETRY.*; make git.service.ts use GIT_CONSTANTS.FETCH_CONFIG.
  Consider an eslint `no-unused-exports`/knip run in CI to keep constants honest.
- **Acceptance**: `grep -rn 'HEAD_REF\|REMOTES_ORIGIN\|UPDATE_EXISTING_WORKTREES\|ACTION_CREATED'
  src` returns only definitions that have a consumer or nothing; sync-retry-policy tests assert the
  defaults equal DEFAULT_CONFIG.RETRY; typecheck/lint/tests green.
- **Notes**: Guards checked: No unused-export lint (eslint config only covers JS files per
  package.json `lint` script) and the constants file grew organically across refactors.

### [ ] T96. Test coverage gaps in the config/CLI subsystem: example config never loaded, no per-repo parallelism or ESM-split reload case, runOnce init-rejection and locked-skip accounting untested, daemon branch of runMultipleRepositories untested, init round-trip only covers the happy path

- **Category**: testing · **Subsystem**: config
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/services/__tests__/config-loader.service.test.ts:996-1021, 1079-1279`,
  `src/utils/__tests__/config-generator.test.ts:294-318`,
  `src/__tests__/index.run-once.test.ts:79-174`, `src/utils/__tests__/cli.test.ts:1-104`,
  `src/utils/__tests__/interactive.test.ts:185-209`
- **Current behavior**: (1) No test loads sync-worktrees.config.example.js, so the F6 regression
  shipped. (2) Parallelism validation tests cover only global/defaults; no repository-level case.
  (3) The reload test covers `.cjs` child modules only; no `.mjs` import case. (4)
  index.run-once.test.ts covers failed outcomes, partial skips and a rejected sync, but not a
  rejected `initialize()` (initFailures path, lines 86-93/155-157) nor a `started:false` result
  (skippedNames/locked accounting, lines 120-124), and the daemon branch (179-205) is only mocked
  away. (5) The generator round-trip test uses a `.js` target with no package.json; no `.cjs`
  target, no `type: commonjs` package, no worktreeDir===configDir case. (6) cli.test.ts never
  asserts `--version`/`--help` output or that `trash` is documented in help. (7) interactive.test.ts
  asserts URL validation but not that stored repoUrl/worktreeDir are trimmed. Failure scenario: Any
  of the defects reported above (example config, per-repo parallelism, ESM reload, init unloadable
  outputs) could be reintroduced by a refactor without a failing test, as already happened for the
  example config after F6.
- **Expected behavior**: Add: a test that buildRepositories() succeeds on the shipped example;
  repository-level parallelism rejection cases; an `.mjs` split-config reload test; index tests for
  init rejection (repo name in the log, failedCount, exit code 1) and for `{started:false,
  reason:'locked'}` (counted as skipped, exit code unchanged); generator round-trip tests for `.cjs`
  target and `type: commonjs` package; a cli test that `--help` lists init/list/trash.
- **Acceptance**: Listed tests exist and pass on the fixed code; each one fails when the
  corresponding fix is reverted (verify by temporarily reverting).
- **Notes**: Guards checked: Coverage thresholds (vitest.config lines 22-27) are global percentages
  and exclude src/index.ts and src/utils/cli.ts entirely, so gaps in these entry points do not move
  the numbers.

### [ ] T97. Auto-detect derives worktreeDir as dirname(current worktree); from inside the default-branch worktree of a repo whose default branch contains '/' this is wrong and create_worktree/update_worktree fail in initialize() with a git 'already checked out' error

- **Category**: correctness · **Subsystem**: mcp
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/mcp/context.ts:534, 565-572` (`detectFromPathUncached worktreeDir /
  syntheticConfig`), `src/mcp/handlers.ts:360-363, 472-475` (`initializeUnlocked() before
  create/update`), `src/services/git.service.ts:151-153, 155-231` (`GitService.initialize
  mainWorktreePath / needsMainWorktree`)
- **Current behavior**: worktreeDir = path.dirname(worktreeRoot) is an unverified guess stored in
  the synthetic config. The default-branch worktree lives at path.join(worktreeDir, defaultBranch)
  (F4 made nested names like release/2024 work), so its dirname is <worktreeDir>/release, not
  <worktreeDir>. GitService.initialize() then computes mainWorktreePath =
  <worktreeDir>/release/release/2024, finds it unregistered, and runs `git worktree add` for a
  branch that is already checked out. Failure scenario: Repo default branch release/2024, agent's
  cwd = <wd>/release/2024 (the main worktree), no config. detect_context reports
  worktreeDir=<wd>/release. create_worktree {branchName:'feature/x'} → service.initializeUnlocked()
  → GitService.initialize → `worktree add <wd>/release/release/2024 release/2024` → git: "fatal:
  'release/2024' is already checked out at '<wd>/release/2024'" (not matched by the 'already exists'
  swallow at git.service.ts:224-231) → tool returns INTERNAL_ERROR with that message;
  update_worktree fails identically. Had the add succeeded (branch not checked out anywhere), a
  second default-branch worktree and any created worktrees would land under <wd>/release, outside
  the real worktreeDir, and a later configured sync would treat them as external.
- **Expected behavior**: Derive worktreeDir from the bare repo's registered worktree list instead of
  the probe path: e.g. take the non-bare registered worktrees, strip the known default-branch path
  components for the default-branch entry (its branch name is in the porcelain output), and use the
  common parent; if the registered worktrees disagree, set createWorktree/updateWorktree unavailable
  with reason 'cannot determine worktreeDir from registered worktrees'. Surface the chosen
  worktreeDir in notes.
- **Acceptance**: context test: bare with worktrees <wd>/release/2024 (branch release/2024) and
  <wd>/feature-x-abc (branch feature/x); detectFromPath(<wd>/release/2024) → result.worktreeDir ===
  <wd> and the synthetic config's worktreeDir === <wd>; detectFromPath(<wd>/feature-x-abc) gives the
  same. Handler-level test: create_worktree in that auto-detect context calls addWorktree with a
  path under <wd>.
- **Notes**: Re-verified: `worktreeDir = path.dirname(worktreeRoot)` at context.ts:534 — one level
  up regardless of how many path segments the branch name contributed.

### [ ] T98. update_worktree on a detached-HEAD worktree: membership passes or fails depending on cache state, fetchBranch is called with the pseudo-branch '(detached abc1234)', and updateWorktree would merge origin/<sha>

- **Category**: correctness · **Subsystem**: mcp
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/mcp/handlers.ts:107-130, 476-479` (`ensureRepoWorktree /
  handleUpdateWorktree`), `src/mcp/context.ts:980-994` (`parseWorktreeList (detached → '(detached
  <sha>)')`), `src/services/git.service.ts:1145-1148, 1490-1502` (`getWorktrees filters detached`),
  `src/services/git.service.ts:1172-1179` (`updateWorktree uses branchSummary.current`)
- **Current behavior**: ensureRepoWorktree consults discovered.allWorktrees first (which includes
  detached worktrees with branch '(detached <sha>)'), and only falls back to git.getWorktrees()
  (which drops detached entries). handleUpdateWorktree then runs git.fetchBranch(worktree.branch)
  and git.updateWorktree(path); updateWorktree uses simple-git branch().current, which is the short
  SHA on detached HEAD. Failure scenario: A worktree is left detached (user ran `git checkout
  <sha>`). update_worktree {path} right after detect_context → membership matches the '(detached …)'
  entry → `git fetch origin '(detached 9768c59)' --prune --progress` → INTERNAL_ERROR "couldn't find
  remote ref". The same call after any invalidateDiscovered() (discovered null → git.getWorktrees
  path) → 'Path … is not a registered worktree of the current repository' — a misleading,
  cache-dependent answer for a path that IS registered. If fetch were skipped, updateWorktree would
  run `merge origin/9768c59 --ff-only` → 'not something we can merge'.
- **Expected behavior**: Both membership sources must agree (include detached entries in both or
  neither); update_worktree should detect detached HEAD up front (parseWorktreeListPorcelain
  detached flag) and return a clear error: 'worktree at <path> is on a detached HEAD (<sha>); check
  out a branch before fast-forwarding'. get_worktree_status already reports 'detached HEAD' in
  reasons; reuse that.
- **Acceptance**: Handler tests: (1) discovered.allWorktrees contains {path, branch:'(detached
  abc1234)'} → update_worktree returns an error mentioning 'detached HEAD' and
  fetchBranch/updateWorktree are not called; (2) with discovered null and git.getWorktrees returning
  the detached entry (extend getWorktrees to include detached with a flag) → same error, not 'not a
  registered worktree'.
- **Notes**: Guards checked: handlers.test.ts only tests branch-bearing worktrees; context.ts and
  git.service.ts parse the same porcelain output with different filters. Verified: in a detached
  scratch repo simple-git branch().current === '9768c59', rev-list HEAD...@{upstream} fails 'HEAD
  does not point to a branch', merge origin/9768c59 --ff-only → 'not something we can merge'
  (scratch t1.mjs).

### [ ] T99. A found-but-broken auto-discovered config is invisible to the agent: detectFromPath logs to stderr, reports kind 'unmanaged'/configPath null, and re-imports the broken file on every subsequent detect_context

- **Category**: workflow · **Subsystem**: mcp
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/mcp/context.ts:240-249` (`detectFromPath auto-load try/catch`),
  `src/mcp/handlers.ts:541-553` (`detectConfigFromLaunchCwd (only load_config gets the real error)`)
- **Current behavior**: When configPath is null, detectFromPath walks up, finds
  sync-worktrees.config.js and calls loadConfig; on failure it writes '[sync-worktrees] auto-loaded
  config failed: …' to stderr and continues. this.configPath stays null, so every later
  detect_context (and the workspace resource read) repeats findConfigUpward + dynamic import (with a
  cache-busting ?t= query, so the module is re-evaluated each time). The response carries no note
  about the config. Failure scenario: A syntax error in sync-worktrees.config.js. Agent calls
  detect_context → {kind:'unmanaged', configPath:null, capabilities.sync:{available:false,
  reason:'no config file loaded (running in auto-detect mode)'}} with no hint that a config exists;
  the agent may create a new config or give up. Each further detect_context re-imports the broken
  file (stderr spam, repeated cost).
- **Expected behavior**: Record the failed path and error on the context (lastConfigLoadFailure
  {path, error, mtimeMs}); add a note 'Found config at <path> but it failed to load: <error>. Fix it
  and call load_config.' to the DiscoveredRepoContext.notes; skip re-importing until the file's
  mtime changes.
- **Acceptance**: context test: workspace with a config file containing a syntax error →
  detectFromPath(...).notes includes the config path and the parse error; a second detectFromPath
  does not call loadConfigFile again (spy on ConfigLoaderService.prototype.loadConfigFile) until the
  file is rewritten.
- **Notes**: Guards checked: handlers.test.ts 'surfaces the real parse error…' covers load_config
  only; context tests only cover valid configs.

### [ ] T100. detect_context with includeStatus + includeAllWorktrees enriches the current repo's worktrees twice (allWorktrees and allWorktreesByRepo[current]) — ~10 git spawns per worktree duplicated; discovery/repo caches never evict

- **Category**: performance · **Subsystem**: mcp
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/mcp/handlers.ts:177-197` (`handleDetectContext enrichment`),
  `src/mcp/handlers.ts:200-227` (`enrichDetectedWorktrees`), `src/mcp/context.ts:166, 235-238,
  258-264` (`discoveryCache (keyed by probed path, never evicted)`), `src/mcp/context.ts:573-580`
  (`detected pseudo-entries accumulate in repos`)
- **Current behavior**: response.allWorktrees (current repo) and
  response.allWorktreesByRepo[currentRepo] contain the same paths; both lists are passed to
  enrichDetectedWorktrees, so each worktree of the current repo gets getFullWorktreeStatus (5
  parallel spawns + up to 3 rev-list/rev-parse + check-ignore) and getDivergence (1) twice.
  Separately, discoveryCache is keyed by the probed path (a probe of 400 different subdirectories
  creates 400 entries, each holding the full allWorktrees array), entries are only marked stale by
  TTL and never removed, and every distinct unmanaged bare repo probed adds a permanent RepoEntry
  (plus a WorktreeSyncService/GitService with per-worktree simple-git caches once any tool touches
  it). Failure scenario: Repo with 300 worktrees, agent calls detect_context {includeStatus:true,
  includeAllWorktrees:true}: ≈300×10×2 = 6,000 git processes instead of 3,000, doubling a call that
  already takes tens of seconds. Long-lived MCP session where the agent runs detect_context {path}
  per worktree it visits: hundreds of cache entries × O(worktrees) each retained for the process
  lifetime.
- **Expected behavior**: Enrich each unique resolved path once (Map<path, enriched>) and reuse for
  both views. Key discoveryCache by the resolved worktreeRoot (not the probed path), evict entries
  older than the TTL on insert, and cap size; drop detected pseudo-entries that are not currentRepo
  when a new one is registered.
- **Acceptance**: Handler test: with allWorktrees == allWorktreesByRepo[test],
  WorktreeStatusService.getFullWorktreeStatus is called exactly once per unique path. Context test:
  probing 3 subdirectories of the same worktree yields __discoveryCacheSizeForTest() === 1; after
  TTL expiry and a new probe, stale entries are gone.
- **Notes**: Guards checked: handlers.test.ts:1435-1461 asserts labels in both views but not the
  call count; the context caching tests only check hit/miss for a single path.

### [ ] T101. list_worktrees per-worktree cost: getDivergence duplicates upstream/rev-list work already done inside getFullWorktreeStatus (≈10-11 git spawns per worktree, ~4,400 processes for 400 worktrees per call)

- **Category**: performance · **Subsystem**: mcp
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/mcp/handlers.ts:288-314` (`listWorktreesForRepo per-worktree Promise.all`),
  `src/mcp/worktree-summary.ts:45-54` (`getDivergence`),
  `src/services/worktree-status.service.ts:228-282` (`collectSnapshot (status, branch -v -a, branch
  -r, stash list, submodule status, rev-parse @{upstream}, rev-list ×2-3)`),
  `src/mcp/handlers.ts:210-213, 329-332` (`same pairing in detect_context and get_worktree_status`)
- **Current behavior**: For each worktree the handler runs git.getFullWorktreeStatus (5 parallel
  spawns, then rev-parse @{upstream}, rev-list --not --remotes, rev-list since-sync and recorded-tip
  when metadata exists, plus check-ignore when untracked files exist) AND getDivergence (a separate
  simple-git instance running rev-list --left-right --count HEAD...@{upstream}). The snapshot
  already resolves the upstream and could compute ahead/behind with the same single rev-list;
  instead two processes plus a fresh simple-git client are spawned per worktree. Concurrency is
  capped at 20 (MAX_STATUS_CHECKS) so a 400-worktree repo issues ≈4,400 sequential-batches of git
  processes for one list_worktrees call (worse than a sync tick, which round-1 #1 measured at 4+6W).
  Failure scenario: Agent calls list_worktrees on a 400-worktree repo with a shared bare repo on a
  network volume: ~4,400 git invocations, tens of seconds to minutes, and clients with a 60 s tool
  timeout give up (no progress notifications are emitted by list_worktrees).
- **Expected behavior**: Extend WorktreeStatusResult with divergence {ahead, behind} computed inside
  collectSnapshot via `rev-list --left-right --count HEAD...<upstream>` (replacing the separate
  ahead-only count where possible) and have the MCP handlers read it instead of calling
  getDivergence; reuse the status service's cached client. Optionally accept a `paths`/`branch`
  filter on list_worktrees so agents can scope the call.
- **Acceptance**: Unit test: for one worktree, count simple-git spawns (spy on raw/status/branch) in
  listWorktreesForRepo — at most 9 with metadata, and no second simple-git instance created for
  divergence; result.divergence equals the previous getDivergence output on a fixture with upstream
  ahead 2/behind 1.
- **Notes**: Guards checked: getDivergence predates fullyPushedUpstreamDeleted work in the status
  service; round-1 #25 covers the `git branch -v -a` cost inside the status service but not the
  MCP-side duplicate divergence probe.

### [ ] T102. Nested regular repos / submodules inside a managed worktree make detect_context return 'unsupported' instead of continuing to the enclosing worktree

- **Category**: workflow · **Subsystem**: mcp
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/mcp/context.ts:1048-1071` (`findWorktreeRoot (stops at first .git)`),
  `src/mcp/context.ts:459-485` (`detectFromPathUncached regular-git-dir / gitdir-structure
  branches`)
- **Current behavior**: findWorktreeRoot returns at the first `.git` it meets while walking up. A
  `.git` directory (vendored repo, `git init` in a subfolder) yields 'regular-git-dir' → unless it
  is a configured clone-mode root, 'Directory has .git folder (regular repo, not a sync-worktrees
  worktree)'; a submodule's `.git` file (gitdir: ../.git/modules/x) yields 'gitdir does not follow
  worktree structure'. The walk never resumes. Failure scenario: Agent's cwd is
  <worktreeDir>/feature-x-<hash>/packages/vendored-lib (a submodule or nested repo). detect_context
  → isWorktree:false, kind:'unsupported', all capabilities unavailable, no currentRepo bootstrap;
  the agent concludes the project is not managed although the parent directory is a managed
  worktree.
- **Expected behavior**: When the first `.git` is a regular directory that is not a configured clone
  root, or a gitdir pointer that is not a `/worktrees/<name>` admin dir, keep walking up to the next
  `.git`; if an enclosing sync-worktrees worktree is found, return it and add a note 'nested
  repository/submodule at <path> ignored'. Only report unsupported when the walk reaches the
  filesystem root.
- **Acceptance**: context test: fixture worktree with a nested directory containing a `.git` dir
  (and another with a submodule-style `.git` file) → detectFromPath(nested) returns isWorktree:true
  with currentWorktreePath = the enclosing worktree and a note naming the nested repo.
- **Notes**: Guards checked: context tests cover only top-level worktree, plain dir, and regular
  repo roots.

### [ ] T103. MCP tool/instruction text and README drift: '.ts' configs are advertised but never discovered or loadable; README still says repo selection falls back to 'the first entry in the config'; list_worktrees fallback error blames initialization when the bare repo is simply missing

- **Category**: docs · **Subsystem**: mcp
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/mcp/server.ts:101, 184` (`SERVER_INSTRUCTIONS / detect_context description
  ('sync-worktrees.config.{js,mjs,cjs,ts}')`), `src/constants.ts:378-382` (`CONFIG_FILE_NAMES (js,
  mjs, cjs only)`), `src/services/config-loader.service.ts:31-46, 49-72` (`findConfigUpward /
  loadConfigFile (import())`), `README.md:275` (`'set by auto-detect, the first entry in the config,
  or set_current_repository'`), `src/mcp/context.ts:219-226` (`loadConfig only auto-selects a
  single-repo config (F8)`), `src/mcp/handlers.ts:275-284` (`listWorktreesForRepo fallback error
  text`)
- **Current behavior**: (1) The server instructions and detect_context description promise
  auto-loading of `.ts` configs; findConfigUpward only probes js/mjs/cjs and loadConfigFile's
  dynamic import of a `.ts` file fails on Node 22 without --experimental-strip-types. (2) README
  says an omitted repoName falls back to the first config entry; since F8 a multi-repo config leaves
  currentRepo null and tools return the ambiguity error. (3) When a configured repo's bare directory
  does not exist yet, git.getWorktrees rejects synchronously ('Cannot use simple-git on a directory
  that does not exist'), the catch falls through to 'Cannot list worktrees - service not initialized
  and no detected context', hiding the real cause and the fix (run initialize). Failure scenario: An
  agent creates sync-worktrees.config.ts because the instructions say it is auto-loaded, then every
  detect_context reports configPath:null. An agent trusting the README calls sync without repoName
  on a two-repo config and gets 'repository selection is ambiguous'. An agent calls list_worktrees
  on a freshly configured repo and gets a message about an uninitialized service with no pointer to
  `initialize`.
- **Expected behavior**: Remove ',ts' from both strings (or add real .ts support: CONFIG_FILE_NAMES
  + loader). Update README line 275 to 'auto-detect, a single-repo config, or
  set_current_repository'. In listWorktreesForRepo, include the underlying error and a hint: 'Cannot
  list worktrees for <repo>: <cause>. If the bare repository has not been cloned yet, call
  initialize.'
- **Acceptance**: server.test.ts baseInstructions constant updated and asserts no 'ts}' substring;
  README diff; handler test: getWorktrees rejects with 'does not exist' and discovered null → error
  message contains the cause and 'initialize'.
- **Notes**: Guards checked: The instruction/description strings are only asserted by equality in
  server.test.ts (so the drift is locked in by the test); README MCP section was not updated with
  F8; the list fallback test (handlers.test.ts:1217-1229) only checks the empty-list path.

### [ ] T104. create_worktree cannot tell the agent that the worktree already existed, yet is annotated idempotentHint:false; response shape hides the no-op

- **Category**: workflow · **Subsystem**: mcp
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `src/mcp/handlers.ts:379-413` (`handleCreateWorktree result`),
  `src/mcp/server.ts:267, 280-286` (`create_worktree description/annotations`),
  `src/services/git.service.ts:566-575` (`addWorktree early return when already a valid worktree`),
  `src/mcp/output-schemas.ts:171-178` (`createWorktreeOutputSchema`)
- **Current behavior**: When <worktreeDir>/<sanitized> is already a registered worktree, addWorktree
  logs and returns; the handler answers {success:true, created:false, pushed:false, worktreePath} —
  identical to 'checked an existing remote branch out into a new worktree'. The tool is declared
  non-idempotent although repeated calls are safe and no-ops. Failure scenario: Agent calls
  create_worktree feature/x twice (retry after a client timeout). Second response is
  indistinguishable from a fresh checkout, so the agent may assume it now has a clean checkout and,
  e.g., skip an update, or report 'created worktree' to the user. Clients that gate re-execution on
  idempotentHint prompt the user needlessly.
- **Expected behavior**: Compute `worktreeExisted` from the pre-call git.getWorktrees() list (the
  handler already fetches `existing`), return it in the structured result (schema: worktreeExisted:
  z.boolean()), mention it in the description, and set idempotentHint:true.
- **Acceptance**: Handler test: getWorktrees returns an entry at the sanitized path with the same
  branch → response.worktreeExisted === true, created === false; fresh path → false. server.test.ts
  tools/list shows idempotentHint true for create_worktree.
- **Notes**: Guards checked: Only the branch `created` flag is modelled; no test covers a
  pre-existing worktree for the same branch.

### [ ] T105. MCP handler tests never exercise RepositoryContext and handlers together; the ctx/service contract is fully mocked, so state-machine regressions (capability bypass, membership cache drift) are invisible

- **Category**: testing · **Subsystem**: mcp
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/mcp/__tests__/handlers.test.ts:115-199` (`makeCtx (hand-written ctx mock)`),
  `src/mcp/__tests__/context.test.ts:1-33` (`WorktreeSyncService mock without sync/getGitService
  behaviour`), `src/mcp/handlers.ts:55-82, 132-154` (`getReadyService ensureInitialized (dead
  option) / duck-typed service casts`)
- **Current behavior**: handlers.test.ts builds a fake ctx whose getDiscoveredContext always returns
  a populated context, getEntry/getService are constant stubs, and invalidateDiscovered is a no-op
  spy; context.test.ts mocks WorktreeSyncService without sync/getGitService. No test drives a
  realistic sequence (detect → mutate → next tool) through the real RepositoryContext. Consequences
  visible in the code: the `ensureInitialized` option of getReadyService is never passed by any
  caller (dead), and isCloneModeService/getWorktreesFromService use `as RepoService & {...}`
  duck-typing purely so test doubles without those methods still work. Failure scenario: The
  capability bypass in finding 1 has been latent since the F8 fix and passes the 1558-test suite;
  any future change to how entry.discovered is refreshed or how currentRepo is chosen can silently
  break the gates or the membership check again.
- **Expected behavior**: Add an integration-style MCP test file that uses the real RepositoryContext
  with a temp bare/worktree fixture and mocks only simple-git +
  WorktreeSyncService.sync/getGitService, covering: auto-detect → mutating tool → sync denied;
  load_config (single and multi repo) → selection; sync outcome with failed counts; list_worktrees
  on missing bare repo; update_worktree after a worktree disappears. Remove the dead
  ensureInitialized option and replace the duck-typed casts with the real WorktreeSyncService type.
- **Acceptance**: New test file src/mcp/__tests__/mcp-flow.test.ts with the sequences above passes;
  typecheck passes after deleting ensureInitialized and the casts (test doubles updated to implement
  isCloneMode/getWorktrees).
- **Notes**: Guards checked: Existing tests were written per-handler with full mocking; the scratch
  bypass test (see finding 1) demonstrates the missing layer.

### [ ] T106. WorktreeStatusView repository sizes get stuck at `calculating...` when the App re-renders while `du` is in flight (effect cleanup discards the result; `repositories` prop is a new array on every App render)

- **Category**: correctness · **Subsystem**: tui
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/components/WorktreeStatusView.tsx:227-258` (`disk usage useEffect (cancelled
  flag + requestedDiskUsageRef)`), `src/components/App.tsx:321-330`
  (`repositories={getRepositoryList()}`), `src/services/InteractiveUIService.tsx:431-437`
  (`getRepositoryList (new array each call)`)
- **Current behavior**: The effect depends on `repositories`; App passes `getRepositoryList()` which
  allocates a new array on every App render (every `addLog`, `setSyncProgress`, `setDiskSpace`
  event). Any App re-render re-runs the effect: the cleanup sets `cancelled = true` for the
  in-flight requests, and the new run skips them because `requestedDiskUsageRef` already contains
  the indexes. When the original `getRepositoryDiskUsage` promise resolves it is discarded, so the
  row stays `Size: calculating...` until the modal is closed and reopened. Failure scenario: User
  opens `w` while a cron sync is running (or right before one starts); `du` for a large repo takes 5
  s; a progress/log event arrives in between → that repo's size never appears. Verified with a
  deferred `getRepositoryDiskUsage` and a `rerender` with a fresh `repositories` array: after
  resolution the frame still shows `calculating` and never `1.00 KB`, with the loader called exactly
  once.
- **Expected behavior**: Do not cancel per-effect-run; keep a single mounted flag (`useRef` set
  false on unmount) and key requests by repo index, or memoize `repositories` in App
  (`useMemo`/stable prop) so identity does not change per render.
- **Acceptance**: WorktreeStatusView test: deferred `getRepositoryDiskUsage`, `rerender` with a new
  `repositories` array, resolve → frame shows the size. App-level test: `repositories` passed to the
  view is referentially stable across `addLog` events.
- **Notes**: Guards checked: `should lazy load repository disk usage` uses a static prop and
  resolves before any re-render; the cancel flag was written for unmount safety without accounting
  for dependency churn.

### [ ] T107. Pressing `q` during a long sync freezes the TUI for up to 30 s with no feedback, then exits mid-sync anyway: `destroy()` sets `isDestroyed` before waiting, so its own 'Waiting for N in-progress sync(s)' and timeout warning are dropped by `addLog`

- **Category**: workflow · **Subsystem**: tui
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/services/InteractiveUIService.tsx:1102-1130` (`destroy`),
  `src/services/InteractiveUIService.tsx:367-396` (`waitForInProgressSyncs`),
  `src/services/InteractiveUIService.tsx:150-157` (`addLog (isDestroyed guard)`),
  `src/services/InteractiveUIService.tsx:38-39`
- **Current behavior**: `destroy()` first sets `isDestroyed = true`, cancels cron, then polls
  `isSyncInProgress()` for up to `WAIT_SYNC_DEFAULT_TIMEOUT_MS` (30 s). Every `addLog`/`setStatus`
  during that window is discarded, including the wait notice and the `Proceeding with potential data
  loss risk` warning, and the UI stays mounted but frozen. After the timeout the app unmounts and
  `process.exit(0)` kills the sync. Failure scenario: A bare-clone or large fetch is running
  (minutes). User presses `q`: nothing visibly happens for 30 s (keys are ignored, no message), then
  the process exits while `git fetch`/`worktree add` is mid-way — the same outcome as not waiting,
  but with a confusing pause. The signal path uses the 2 s fast timeout, the `q` path the 30 s one,
  with no way to force-quit from the keyboard.
- **Expected behavior**: Emit a visible status (`Quitting — waiting for 1 sync to finish (press q
  again to force)`) before flipping `isDestroyed`, keep rendering during the wait, and let a second
  `q`/Ctrl+C shortcut the wait. Document that the sync is interrupted if the timeout elapses.
- **Acceptance**: Test: with `isSyncInProgress()` returning true, calling `destroy()` emits an
  `addLog`/`setStatus` event describing the wait before any `unmount`; a second `destroy(true)` (or
  a `forceQuit` signal) resolves within the fast timeout.
- **Notes**: Guards checked: Tests `should resolve quickly when called with fast option…` and
  `should use slow timeout by default…` assert timing only, never user-visible feedback; the
  `isDestroyed` guard was designed for post-teardown safety and is set too early.

### [ ] T108. Reload (`r`) initializes the new services before injecting the UI logger, so clone/fetch/init output and warnings of the reload go to the raw console instead of the log panel

- **Category**: workflow · **Subsystem**: tui
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/services/InteractiveUIService.tsx:275-292` (`handleReload (new
  WorktreeSyncService + initialize)`), `src/services/InteractiveUIService.tsx:313-316`
  (`injectLoggersIntoServices after init`), `src/services/worktree-sync.service.ts:66` (`default
  Logger.createDefault when config.logger is unset`)
- **Current behavior**: `handleReload` constructs each new `WorktreeSyncService(repoConfig)` (config
  loader sets no `logger`, so the service and its GitService/CloneSyncService use the console
  logger) and awaits `initialize()` — which may perform a full bare clone, `fetch --all`,
  default-branch detection, stale-registration repair and LFS verification, all logged through
  `console.log/warn`. Only after all inits succeed does `injectLoggersIntoServices()` wire the UI
  output function. In alternate-screen mode Ink's patched console writes the text and immediately
  repaints the full-screen frame over it, so those lines are effectively invisible. Failure
  scenario: User edits the config to add a repo and presses `r`. The new repo's bare clone runs for
  minutes with no progress in the log panel (`Reloading configuration...` is the last line);
  warnings such as `Could not clear stale registration…` or LFS verification notices are lost. Only
  a hard failure surfaces (`Failed to initialize repository: …`).
- **Expected behavior**: Call `service.updateLogger(new Logger({repoName, debug, outputFn}))` (and
  subscribe progress) immediately after constructing each new service, before `initialize()`; or
  pass `logger` in the config object handed to the constructor.
- **Acceptance**: interactive-ui test: on reload, `WorktreeSyncService.updateLogger` is called
  before `initialize()` for every new service (order assertion on mock call sequence); a log emitted
  from inside the mocked `initialize()` appears as an `addLog` event.
- **Notes**: Guards checked: Round-1 #10 concerns sub-services that never receive `updateLogger`;
  this is an ordering gap in the reload path only (the startup path injects loggers in the
  constructor before any operation). The test `should re-inject loggers after reload` only checks
  that injection happens, not when.

### [ ] T109. Docs/help drift: README and the help modal say `Esc` quits, but the main screen ignores Esc; README quick start says the TUI 'starts syncing' while the daemon never syncs until the first cron tick and no `syncOnStart` option remains

- **Category**: docs · **Subsystem**: tui
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `README.md:89, 297`, `src/components/HelpModal.tsx:157-168`,
  `src/components/App.tsx:161-193` (`useInput (no key.escape branch on the main screen)`),
  `src/index.ts:180-205` (`runMultipleRepositories daemon branch (no initial sync)`)
- **Current behavior**: App's main-screen `useInput` handles `q`, `?`, `h`, `c`, `o`, `w`, `x`, `s`,
  `r` only; Esc does nothing (verified: writing `\x1b` never calls `onQuit`). The daemon branch of
  `runMultipleRepositories` sets up cron jobs and logs the schedule but never calls
  `triggerInitialSync()`; CHANGELOG 4.0.0 removed `--sync-on-start` without a config replacement.
  Failure scenario: A new user runs `sync-worktrees init` then `sync-worktrees` on a fresh machine
  expecting the workspace to materialize (`Quick start: … starts syncing`); with the default `0 * *
  * *` schedule nothing happens for up to an hour unless they discover `s`. Pressing Esc to quit (as
  the help says) does nothing.
- **Expected behavior**: Either implement Esc-to-quit (with the same confirmation semantics as `q`)
  or remove it from README/HelpModal. Either trigger an initial sync on TUI start (or add
  `defaults.syncOnStart`, default true) or reword README line 89 and state in the TUI keybindings
  section that the first sync waits for the schedule.
- **Acceptance**: App test: Esc on the main screen calls `onQuit` (or docs updated and the help
  modal no longer lists Esc). index test: daemon start invokes `triggerInitialSync` when
  `syncOnStart` is enabled; README updated accordingly.
- **Notes**: Guards checked: HelpModal.test.tsx checks the help text renders, not that the listed
  keys work; App.test.tsx has no Esc case; index.run-once.test.ts mocks the UI service without
  asserting an initial sync.

### [ ] T110. Quitting the TUI SIGTERMs (then SIGKILLs) the whole process group of every in-flight `onBranchCreated` hook (e.g. `npm install` in the new worktree) — undocumented, contradicts 'fire-and-forget'

- **Category**: guardrail · **Subsystem**: tui
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/services/InteractiveUIService.tsx:1112` (`destroy →
  hookExecutionService.cleanup()`), `src/services/hook-execution.service.ts:124-144, 240-250`
  (`cleanup / terminateChild (process.kill(-pid))`), `README.md:616`
- **Current behavior**: Hooks are spawned detached in their own process group and described as
  fire-and-forget, but `destroy()` (q, SIGTERM, and Ctrl+C once fixed) calls `cleanup()`, which
  sends SIGTERM to each hook's process group and SIGKILL 5 s later, regardless of how far the hook
  has progressed. Failure scenario: User creates a branch via `c`; the configured hook `npm ci`
  starts in the new worktree; 20 s later the user quits the TUI. `npm ci` is killed mid-extraction,
  leaving a partially populated `node_modules` and no log line explaining why the hook 'exited'. The
  next `npm ci` must redo the work; a hook that writes config files may leave a half-written file.
- **Expected behavior**: Decide and document: either let detached hooks outlive the TUI (drop
  `cleanup()` from the quit path, keep it for reload/hard exit), or warn on quit (`N hook(s) still
  running — press q again to terminate them`) and log a `[hook] terminated on exit` line. README's
  hook section should state the chosen behavior.
- **Acceptance**: Test: with an active hook child in `HookExecutionService`, `destroy()` either does
  not signal it (option A) or emits a warning log naming the running hook count before signalling
  (option B). README updated.
- **Notes**: Guards checked: hook-execution tests cover timeouts and the F17 timer leak, not the
  quit path; nothing in the TUI surfaces running hooks. This is a design decision, not a crash,
  hence low.

### [ ] T111. Editor mode spawns `$EDITOR` detached with stdio ignored, so terminal editors (vim/nvim/nano/emacs -nw — the most common `$EDITOR` values) silently do nothing while the wizard reports success and closes

- **Category**: workflow · **Subsystem**: tui
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/services/InteractiveUIService.tsx:799-828` (`openEditorInWorktree`),
  `src/components/OpenEditorWizard.tsx:75-90` (`handleOpen`), `README.md:329`
- **Current behavior**: `spawn(command, [...args, worktreePath], { detached: true, stdio: "ignore"
  })` gives the editor no TTY. GUI editors (`code`, `subl`) work; a terminal editor reads EOF from
  /dev/null and exits (or lingers) without ever being visible. The method returns `{ success: true
  }` optimistically and the wizard closes with no error; only a spawn ENOENT is reported. Failure
  scenario: Linux/macOS user with `EDITOR=vim` (system default on many distros) selects a worktree,
  presses Tab for Editor mode, Enter: the wizard closes, nothing opens, no log line. The user cannot
  tell whether the feature is broken or the editor crashed.
- **Expected behavior**: Detect terminal editors (basename in a small list: vi, vim, nvim, nano,
  pico, emacs with `-nw`, micro, helix/hx, kak) and either route them through the terminal launcher
  (`sh -c '<editor> <path>'` inside the tmux/terminal command) or return `{ success:false, error:
  "EDITOR 'vim' is a terminal editor; use Terminal mode or set EDITOR to a GUI editor" }` and log
  it. Document the GUI-editor requirement in README.
- **Acceptance**: Unit test: `EDITOR=vim` → `openEditorInWorktree` does not `spawn` detached with
  `stdio:"ignore"` (either delegates to the terminal launcher or returns a descriptive error shown
  by the wizard). README states which editors are supported.
- **Notes**: Also reported by the process reviewer: neither editor nor terminal mode observes the
  launcher's exit code, so the wizard reports success for a spawn that exits immediately. Also
  reported as: “Editor mode silently does nothing for terminal editors (EDITOR=vim/nvim/nano/…): the
  editor is spawned detached with stdio ignored, dies after ~2 s, and the wizard reports success;
  launcher exit codes are never observed for either editor or terminal mode”.

### [ ] T112. `$TERMINAL=gnome-terminal` (and other `$TERMINAL`/`SYNC_WORKTREES_TERMINAL` values needing `--`) is launched with `-e sh -c <cmd>`, which the probe path already knows is wrong for gnome-terminal; command strings are split on whitespace so paths with spaces break

- **Category**: workflow · **Subsystem**: tui
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/services/InteractiveUIService.tsx:874-914` (`resolveTerminalLauncher`),
  `src/services/InteractiveUIService.tsx:916-920` (`parseCommandString`), `src/constants.ts:140-144`
  (`TERMINAL_CONSTANTS.LINUX_CANDIDATES`)
- **Current behavior**: When probing candidates, `gnome-terminal` is special-cased to `-- sh -c
  <cmd>` (line 903-905) because its `-e` takes a single string and rejects trailing arguments. The
  `$TERMINAL` branch (897-900) ignores that and always appends `-e sh -c <cmd>`, so
  `TERMINAL=gnome-terminal` (a common GNOME setting) fails to open or opens a bare `sh`.
  `parseCommandString` splits on `\s+`, so `SYNC_WORKTREES_TERMINAL='"/Applications/My
  Term.app/Contents/MacOS/term" -e'` becomes a broken argv. Failure scenario: GNOME user with
  `TERMINAL=gnome-terminal` presses `o` → Enter: the launcher spawns `gnome-terminal -e sh -c 'tmux
  new-session …'`; gnome-terminal treats `-c` as an unknown option and exits with an error (stdio is
  ignored, so nothing is shown); the wizard reports success. Without `$TERMINAL`, the same machine
  works because the probe path uses `--`.
- **Expected behavior**: Apply the same per-emulator argument rule in the `$TERMINAL` branch
  (basename `gnome-terminal` → `--`), or document that env launchers must accept `-e <argv…>`; parse
  command strings with a minimal shell-quote aware splitter (or accept an array via JSON).
- **Acceptance**: interactive-ui test: `process.env.TERMINAL = "gnome-terminal"` on linux → spawn
  args start with `["--", "sh", "-c", …]`; a quoted path in `SYNC_WORKTREES_TERMINAL` yields a
  single command argv element.
- **Notes**: Guards checked: Tests cover `SYNC_WORKTREES_TERMINAL="alacritty -e"` and macOS paths
  only; gnome-terminal is only tested implicitly through the candidate loop. Not verified
  empirically (no gnome-terminal available), hence moderate confidence.

### [ ] T113. NODE_ENV=test silently disables the cross-process lock, and the e2e double-run test (spawning dist under the inherited NODE_ENV=test) therefore never exercises locking; no test anywhere runs two real processes against one repo

- **Category**: testing · **Subsystem**: process
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/services/repo-operation-lock.ts:29-32` (`RepoOperationLock.acquire`),
  `src/__tests__/e2e/double-run.test.ts:93-97, 125-131`, `src/__tests__/setup.ts:5`,
  `src/services/__tests__/repo-operation-lock.test.ts:15-16, 33-42`
- **Current behavior**: acquire() returns a no-op release when process.env.NODE_ENV === 'test'
  (repo-operation-lock.ts:30-32). vitest sets NODE_ENV=test and setup.ts:5 forces it;
  double-run.test.ts runs `node dist/index.js` via execSync without overriding env, so the child
  inherits NODE_ENV=test and runs with locking disabled (as do
  runMaintenanceIfDueUnlocked/runTrashMaintenanceUnlocked, worktree-sync.service.ts:398, 408).
  repo-operation-lock.test.ts mocks both fs/promises and proper-lockfile, so the real lock
  directory/mtime/stale logic (and the two-lock ordering in worktree mode) is never executed. The
  only 'concurrency' e2e is sequential. A user who happens to run the daemon with NODE_ENV=test
  exported (e.g. a CI box or a shell where a test runner left it set) gets no lock with no warning.
  Failure scenario: A regression in lock key derivation (such as the XDG_STATE_HOME finding) or in
  proper-lockfile option handling passes the entire suite green. Demonstrated: two concurrent
  `--runOnce` processes with NODE_ENV=test both report '1 synced' and both run the full sync in the
  same bare repo/worktreeDir.
- **Expected behavior**: Add an e2e test that runs two `dist/index.js --runOnce` processes
  concurrently with `env: {...process.env, NODE_ENV: 'production'}` (and a fetch slowed by a
  hook/large repo or a pre-held proper-lockfile lock on the computed target) and asserts exactly one
  prints 'Another process holds the sync lock' and exits 0 with '1 skipped'. Consider gating the
  test-mode bypass on an explicit variable (e.g. SYNC_WORKTREES_DISABLE_LOCK=1 set only by unit-test
  setup) rather than the ambient NODE_ENV, and log a warning when the bypass is active outside
  vitest.
- **Acceptance**: New e2e test fails if `RepoOperationLock.acquire` is stubbed to always return a
  release, and passes on HEAD once env is overridden. Existing tests unchanged.
- **Notes**: Guards checked: The bypass is intentional for unit tests but leaks into the e2e layer
  through env inheritance; no test asserts lock contention between processes.

### [ ] T114. onBranchCreated hooks are killed at a hard-coded, undocumented 60 s timeout (the example config's own `pnpm install` hook routinely exceeds it); `setTimeoutMs` is never wired to config, and completion logs omit which hook finished

- **Category**: workflow · **Subsystem**: process
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/services/hook-execution.service.ts:20-24, 103-114`
  (`HookExecutionService.timeoutMs / executeCommandInBackground`), `src/constants.ts:56`
  (`HOOK_TIMEOUT_MS`), `src/services/branch-created-actions.service.ts:68-79` (`runHooks
  callbacks`), `sync-worktrees.config.example.js:247-259`, `README.md:616`
- **Current behavior**: Every hook gets a 60 000 ms timer (103-114); on expiry the whole process
  group is SIGTERMed and SIGKILLed 5 s later. `setTimeoutMs` (22-24) has no caller outside tests,
  there is no `hooks.timeoutMs`/`hookTimeoutMs` config field (grep of src/types, config-loader:
  none), and neither README nor the example config mention a timeout. The example config suggests
  `sh -c 'cd "$SYNC_WORKTREES_WORKTREE_PATH" && pnpm install'` (line 256), which on a medium
  monorepo takes minutes. onComplete logs 'Command completed successfully' / 'Command exited with
  code N' without the command (72-79), so with several hooks the user cannot tell which one failed.
  Failure scenario: Config: hooks.onBranchCreated: ["sh -c 'cd $SYNC_WORKTREES_WORKTREE_PATH && pnpm
  install'", "code {WORKTREE_PATH}"]. User creates a branch from the TUI; 60 s in, the log shows
  '[hook] Failed to execute '…pnpm install…': Hook timed out after 60000ms' and node_modules is left
  half-written (pnpm interrupted mid-link). There is no config knob to raise the limit; the only
  workaround is `nohup … &` inside the hook, which defeats output capture.
- **Expected behavior**: Add `hooks.timeoutMs` (per repo, inheriting from defaults; 0 or 'none' = no
  timeout) validated as a positive integer in validateHooksConfig, threaded to
  HookExecutionService.setTimeoutMs (or per-call). Document the default in README's hooks section
  and the example config. Include the command (or its index) in onComplete log lines.
- **Acceptance**: Config-loader test: `hooks: { onBranchCreated: [...], timeoutMs: 600000 }`
  resolves and a non-integer is rejected with a ConfigError naming the field. Hook-execution test: a
  hook that sleeps 200 ms with timeoutMs 100 fires onError('timed out'); with timeoutMs 0 it
  completes normally. Log assertion: onComplete message contains the command.
- **Notes**: Guards checked: F17 fixed only the leaked kill timer. hook-execution.service.test.ts
  tests the timeout mechanism via setTimeoutMs but nothing connects it to user configuration.

### [ ] T115. Repository initialization failures are logged without the repository name in both runOnce and reload paths, so with parallel init the user cannot tell which repo failed

- **Category**: workflow · **Subsystem**: process
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/index.ts:86-93` (`runMultipleRepositories (initResults loop)`),
  `src/services/InteractiveUIService.tsx:296-303` (`handleReload (initResults loop)`)
- **Current behavior**: Both loops iterate Promise.allSettled results and log `Failed to initialize
  repository: ${reason}` from the rejection alone. The repo name is available (repositories[i].name,
  same index order) but not used. With maxRepositories ≥ 2 the per-repo header lines
  (index.ts:66-71) from different repos interleave, and git error messages (e.g. 'Could not read
  from remote repository') rarely contain the URL. Failure scenario: Config with 6 repos, one with a
  revoked deploy key: runOnce prints '❌ Failed to initialize repository: Error: … Permission denied
  (publickey)' somewhere between other repos' output; the exit code is 1 but the user has to bisect
  the config to find the failing entry. In the TUI reload path the same message appears in the log
  panel with no repo attribution at all.
- **Expected behavior**: Log `Failed to initialize repository '<name>' (<repoUrl>): <message>` using
  the index into `repositories`, in both places; keep the error object for debug mode.
- **Acceptance**: Test for runMultipleRepositories (or an extracted helper) with one rejecting
  initialize: the logged error line contains the repo name. Same for handleReload.
- **Notes**: Guards checked: Round-1 #9/#23 are about branch/path context in sync-phase skips; init
  failures were not covered.

### [ ] T116. FileCopyService silently applies a hard-coded ignore list (dist/, build/, .next/, coverage/, …) even to explicit file patterns, swallows glob errors, and a zero-match copy produces no log line at all

- **Category**: workflow · **Subsystem**: process
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/services/file-copy.service.ts:8-15` (`DEFAULT_IGNORE_PATTERNS`),
  `src/services/file-copy.service.ts:58-79` (`expandPatterns`),
  `src/services/branch-created-actions.service.ts:32-52` (`BranchCreatedActionsService.copyFiles`)
- **Current behavior**: Every pattern is expanded with `ignore: DEFAULT_IGNORE_PATTERNS` (66-71), so
  `filesToCopyOnBranchCreate: ['build/local.settings.json']` or `['coverage/.nycrc']` matches
  nothing; the ignore list is undocumented (README 617, example config). glob failures are caught
  and dropped ('skip silently', 73-75), e.g. an unreadable sourceDir. BranchCreatedActionsService
  only logs when copied.length > 0 or errors.length > 0 (40-49), so a run that matched nothing is
  indistinguishable from the feature being unconfigured. Failure scenario: User keeps environment
  overrides under `build/` (a directory name the list ignores) and configures the copy; every branch
  creation silently copies nothing; the user assumes the feature is broken (it was, before F2) and
  cannot see why.
- **Expected behavior**: Apply the ignore list only to patterns containing glob magic (use glob's
  `hasMagic`/a simple check), never to literal paths; document the defaults and allow overriding via
  `filesToCopyIgnore` or by an explicit `!pattern` entry; log a warning when glob throws; log at
  info level when a copy pass produced zero matches ('no files matched [patterns] in <sourceDir>').
- **Acceptance**: file-copy tests: literal pattern 'build/x.json' copies the file even though build/
  is in the default ignore list; glob '**/*.json' still skips build/; expandPatterns surfaces a glob
  error in result.errors. branch-created-actions test asserts an info log on zero matches.
- **Notes**: Guards checked: F2 restored relative-pattern semantics but kept the unconditional
  ignore list; no diagnostic for zero matches exists on either call site.

### [ ] T117. Reload/cancel stops cron tasks with `stop()` but never `destroy()`s them; node-cron v4's module-level registry retains every stopped task (and, through its closure, every previous generation of WorktreeSyncService instances) for the life of the daemon

- **Category**: performance · **Subsystem**: process
- **Severity**: Low · **Verification**: finder's evidence and code citations, not independently
  re-read
- **Location**: `src/services/InteractiveUIService.tsx:188-193` (`cancelCronJobs`),
  `src/services/InteractiveUIService.tsx:180-185, 309-321` (`setupCronJobs / handleReload`)
- **Current behavior**: cancelCronJobs calls `job.stop()` and drops the array. In node-cron 4.6.0,
  `schedule()` adds every task to a global TaskRegistry
  (node_modules/node-cron/dist/node-cron.js:9-30, 661) which removes it only on the 'task:destroyed'
  event; `stop()` (InlineScheduledTask, _shared.js:1177-1180) clears the runner timer but does not
  destroy. The task's callback closes over `services` (181-183), i.e. the old WorktreeSyncService
  objects with their per-worktree simple-git caches (round-1 #11 notes ~20 KB per worktree
  retained), progress emitters and loggers. Each `r` reload therefore adds one generation of
  services that can never be collected. Failure scenario: Daemon with 5 repos × 300 worktrees,
  operator reloads config a few times a day: after two weeks the registry holds dozens of dead
  generations, each pinning MB of simple-git instances and closures; `cron.getTasks()` grows
  monotonically.
- **Expected behavior**: cancelCronJobs should call `job.destroy()` (or stop then destroy) so the
  registry releases the task; destroy() should also be used in `destroy()` teardown.
- **Acceptance**: Unit test with node-cron mocked: cancelCronJobs invokes destroy on every scheduled
  task; integration assertion using cron.getTasks().size before/after a reload returns to the
  pre-reload count.
- **Notes**: Guards checked: node-cron v3 semantics (where stop was final) predate the 4.x upgrade;
  no test inspects the registry.

### [ ] T118. Prettier is configured (`.prettierrc`) but not installed, has no script, and is never enforced in CI

- **Category**: workflow · **Subsystem**: build-ci-tests
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `.prettierrc:1`, `package.json:11-27` (`scripts / devDependencies`)
- **Current behavior**: `.prettierrc` exists at the root but `prettier` is not in devDependencies,
  `node_modules/.bin/prettier` does not exist, there is no `format`/`format:check` script, and
  neither pr.yml nor a pre-commit hook runs it. Formatting consistency currently depends on each
  contributor's editor picking up the config. Failure scenario: Two contributors with different
  editor setups produce whitespace/quote churn in the same files; reviews fill with formatting diffs
  and `git blame` degrades. Nothing fails.
- **Expected behavior**: Add `prettier` as a devDependency pinned to a major, add `format` and
  `format:check` scripts, run `format:check` in the PR workflow (or via lint-staged/simple-git-hooks
  pre-commit), and run `prettier --write` once so the check starts green.
- **Acceptance**: `pnpm format:check` exists and passes on `main`; CI fails on an unformatted file.
- **Notes**: Guards checked: Checked devDependencies, scripts, node_modules/.bin and both workflows.

### [ ] T119. CI only exercises Node 24 while `engines` promises `>=22.0.0`; the minimum supported runtime (and the ESM module-detection behaviour that differs across 22.x) is never tested

- **Category**: workflow · **Subsystem**: build-ci-tests
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `.github/workflows/pr.yml:27-29, 61-63` (`node-version: 24`),
  `.github/workflows/release.yml:29-31`, `package.json:41-43` (`engines.node`),
  `esbuild.config.js:13` (`target: node22`)
- **Current behavior**: Both CI jobs and the release job pin `node-version: 24`. The bundle targets
  `node22` and `engines.node` is `>=22.0.0`, so users on Node 22 LTS run code that was never built
  or tested on that runtime. Node 22.0–22.6 do not have unflagged ESM syntax detection for
  extensionless/`.js` files, which matters for the generated ESM config file loaded via `import()`.
  Failure scenario: A dependency bump (e.g. `@modelcontextprotocol/server` v2, `glob` 13, `zod` 4)
  or a use of a Node 24-only API passes CI and breaks `npx sync-worktrees` for every Node 22 user.
- **Expected behavior**: Run the lint/typecheck/build/test job on a matrix of `[22, 24]` (or at
  least the engines minimum), and keep the release job on the version the maintainer publishes with.
- **Acceptance**: pr.yml runs the test job on Node 22 and Node 24; both green on `main`.
- **Notes**: Guards checked: No matrix in any workflow; the composite action defaults to 24.

### [ ] T120. No post-build smoke test: CI builds `dist/` but never executes the CLI or imports the MCP bundle, so a bundling regression is only caught after publish

- **Category**: testing · **Subsystem**: build-ci-tests
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `.github/workflows/pr.yml:70-74` (`Build Project / Run Tests`),
  `esbuild.config.js:17-40`, `package.json:10, 22` (`bin / prepublishOnly`)
- **Current behavior**: Tests import TypeScript sources through vitest, not the esbuild bundle.
  `pnpm build` is run in CI but nothing runs `node bin/sync-worktrees.js --version`, `node
  dist/mcp-server.js` (stdio handshake), or `node -e "import('./dist/index.js')"`. The
  `react-devtools-core` alias, `packages: 'external'`, the `#!/usr/bin/env node` banner and the
  `__SYNC_WORKTREES_VERSION__` define are therefore untested. Failure scenario: A new dependency
  that esbuild must treat differently (e.g. a package with a `browser` condition, or a dynamic
  `require` in `ink`) bundles 'successfully' but throws at import time; CI is green and the
  published package fails on `npx sync-worktrees`.
- **Expected behavior**: Add a CI step after build that runs `node bin/sync-worktrees.js --version`,
  `node dist/mcp-server.js` with a minimal `initialize` request piped on stdin, and `npm pack
  --dry-run` with a check that `dist/index.js` and `dist/mcp-server.js` are included. The existing
  MCP stdio integration test (see the `.mcp-stdio-test-*` gitignore entry) can be promoted to run
  against `dist/`.
- **Acceptance**: A deliberately broken esbuild alias makes the PR job fail at the smoke step.
- **Notes**: Guards checked: Checked pr.yml, release.yml, package.json scripts and vitest config
  (tests target `src/`).

### [ ] T121. Published package ships 156 files / 2.6 MB unpacked, including `.d.ts.map` files and JS sourcemaps with the full TypeScript source embedded via `sourcesContent`

- **Category**: workflow · **Subsystem**: build-ci-tests
- **Severity**: Low · **Verification**: code re-read by the coordinating reviewer
- **Location**: `package.json:44-49` (`files`), `esbuild.config.js:12` (`sourcemap: true`),
  `tsconfig.json:18-20` (`declarationMap / sourceMap`)
- **Current behavior**: `npm pack --dry-run` lists 156 files, 567 kB packed / 2.6 MB unpacked.
  `dist/index.js.map` and `dist/mcp-server.js.map` embed `sourcesContent` (the entire `src/` tree),
  and every `.d.ts` has a `.d.ts.map` pointing at `../src` paths that do not exist in the package.
  Failure scenario: Install size and `npx` cold-start download are ~4x what the bundle needs; the
  declaration maps are dead weight because `src/` is not published; stack traces still resolve
  because the JS maps embed sources, so removing `sourcesContent` is the only behaviour-changing
  choice to make deliberately.
- **Expected behavior**: Decide on one: keep JS sourcemaps but set `declarationMap: false` (or
  exclude `*.d.ts.map` via `.npmignore`/`files`), and consider `sourcesContent: false` in esbuild to
  ship map files without the source tree. Add the `npm pack --dry-run` file count to the smoke step
  so it does not creep.
- **Acceptance**: `npm pack --dry-run` shows no `.d.ts.map` files and the unpacked size is under ~1
  MB (or the maintainer documents why maps are kept).
- **Notes**: Guards checked: `files` restricts to `bin`, `dist`, README, LICENSE, but `dist`
  contains everything tsc and esbuild emit.

---

## Needs product decision (do not implement without maintainer sign-off)

- **T36** — Should daemon/TUI mode sync immediately on start (the pre-4.0 `--sync-on-start`
  behaviour) or only on the cron schedule? Options: (a) sync on start by default; (b) add
  `defaults.syncOnStart` (default true or false); (c) keep current behaviour and correct README line
  89. (a) or (b) is the smaller surprise for a tool whose README says the bare command 'starts
  syncing'.
- **T39** — Should MCP tool input schemas reject unknown arguments (strict) or keep stripping them?
  Options: (a) strict schemas — a misspelled `repo_name` fails fast instead of silently targeting
  the current repo; (b) keep permissive but echo ignored keys in the response. (a) is safer for
  agent callers; check that popular MCP clients do not inject extra keys.
- **T48** — Should `hooks.onBranchCreated` and `filesToCopyOnBranchCreate` fire for worktrees
  created by sync and by the MCP `create_worktree` tool, as the README says, or only for TUI-created
  branches? Options: (a) wire `BranchCreatedActionsService` into `createNewWorktrees` and
  `handleCreateWorktree` (the daemon then runs user hook commands unattended — document it); (b)
  narrow the README and the config comments to the TUI wizard. Decide before touching T69/T116.
- **T59** — Is a dry-run / plan surface wanted (`sync-worktrees plan` / `--dry-run`, and an MCP
  `plan_sync` tool)? Options: (a) add it — the planner is already pure so the cost is a CLI/MCP
  wrapper plus outcome formatting; (b) decline and close the item.

---

## Suggested batching for agents

- **Batch 1 (guardrails, small and isolated)**: T1, T38, T40, T30, T10, T5, T50, T22, T21, T49, T47,
  T29 — Each is a contained check or env fix with its own unit test and no cross-coupling; together
  they close the 'reports success while doing less' and 'runs without its safety net' class.
- **Batch 2 (worktree-mode create/update correctness)**: T17, T18, T3, T63, T6, T9, T19, T20, T24,
  T23, T4, T8, T62, T77, T78, T81, T64, T2, T53, T54, T55, T56, T57, T58, T60 — All in
  git.service.ts / worktree-status.service.ts / the sync runner; do T17 first because T3, T6 and T63
  change the same create/update probes, then land the spawn-count reduction (T2, T57) on top of the
  corrected probes.
- **Batch 3 (clone mode)**: T12, T13, T14, T15, T16, T72, T73, T67, T68, T66, T71, T74, T75, T76,
  T65, T69, T70 — One file (clone-sync.service.ts) plus its TUI entry points; T12/T13 change
  adoption, T14/T15 the fetch/merge clients, the rest are independent.
- **Batch 4 (trash, diverged and removal safety)**: T26, T27, T28, T11, T7, T82, T83, T84, T85, T86,
  T87, T89, T90 — Touches the removal and restore paths; write the real-git coverage in T90 first,
  then the manifest/reaper fixes (T26, T27), then the force-clean preview snapshot (T28) and the
  copy/rename changes (T11, T87).
- **Batch 5 (config loading, CLI and init)**: T31, T32, T33, T34, T35, T36, T91, T92, T93, T94, T95,
  T96, T79, T80, T61 — config-loader.service.ts, config-generator.ts and index.ts; validation
  additions (T32, T91, T80) share one validator pass, T31/T94/T61 are doc fixes that should ride
  with the code that makes them true.
- **Batch 6 (MCP server)**: T37, T39, T97, T98, T99, T100, T101, T102, T103, T104, T105, T59 —
  handlers.ts / context.ts / server.ts; T39 (strict schemas) and T59 (dry-run surface) need the
  product decisions below, the rest are independent handler fixes plus the context/handler
  integration tests (T105).
- **Batch 7 (TUI and process lifecycle)**: T41, T42, T43, T44, T45, T46, T25, T88, T106, T107, T108,
  T109, T110, T111, T112, T113, T114, T115, T116, T117, T48 — InteractiveUIService.tsx and the Ink
  components; T42 (Ctrl+C) and T43 (mouse tracking) share the exit path, T25/T88 share the
  status-view fan-out, T111/T112 share the launcher code.
- **Batch 8 (CI, tooling and packaging)**: T51, T52, T118, T119, T120, T121 — package.json and
  .github only; T51 will surface lint findings across src/, so land it before the code batches or
  expect churn.

---

## Verification method

Findings were produced by subsystem-scoped review agents (one or two per subsystem, each reading
its files completely and running throwaway git/node experiments where a claim was cheap to test),
then de-duplicated and re-read against the cited code by the coordinating reviewer. Each item
carries a verification tag: items marked *code re-read* were independently confirmed by reading
the cited code paths; items marked *finder's evidence* rest on the reviewing agent's own reading
and experiments and were not independently re-read. One finding was dropped as out of scope
(Windows path case-folding; Windows is not a supported platform) and twenty-two duplicate reports
were merged into the items they duplicate (listed under **Notes** as 'Also reported as'). The
documentation, CI/tooling and security sweeps ran at reduced depth (see the caveat in the summary).
Per-item review transcripts are not included.
