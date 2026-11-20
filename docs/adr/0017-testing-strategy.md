# ADR-0017: Testing strategy

- **Status:** Accepted
- **Date:** 2026-11-20
- **Source:** 377 code comments as of `5f17242`, moved here by [ADR-0001](./0001-record-decisions-in-adrs-not-comments.md)

## Context

Tests run in three vitest projects: unit, integration (real git, no build) and e2e (spawns the built CLI). These decisions cover test infrastructure: how git is faked or used for real, how timing and the filesystem are controlled, and how suites stay isolated from the developer's own git config.

## Decisions

Grouped by the file that implements them, source before tests. Each entry names the symbol it governs.

### `src/components/RepositoryDashboard.tsx`

- **RepositoryDashboardProps.refreshMs**: RepositoryDashboard's refreshMs prop exists so tests can control how often relative times are recomputed; production uses DASHBOARD_REFRESH_MS.

### `src/constants.ts`

- **ENV_CONSTANTS.UNIT_TEST_SHORTCUT**: SYNC_WORKTREES_UNIT_TEST is set by src/__tests__/setup.ts to the vitest worker's pid and consumed by src/utils/unit-test-shortcut.ts.

### `src/utils/unit-test-shortcut.ts`

- **isUnitTestShortcutEnabled**: The unit suite runs services in-process against mocked git/fs, so the repo lock, git inactivity timeouts, trash reaping and periodic gc are short-circuited for it. The opt-in variable holds the vitest worker's own pid and is honoured only by a process whose pid matches, so child processes (e2e-spawned CLIs, hook commands) that inherit the environment still run the real code. NODE_ENV is deliberately not used because shells, CI and .env files set it for unrelated reasons.
- **warnIfUnitTestShortcutEnabled**: Process entry points (CLI and MCP server) call warnIfUnitTestShortcutEnabled at startup so a stray copy of the unit-test variable can never disable locking, timeouts, trash reaping or gc unnoticed.

### `vitest.config.ts`

- **vitest.config E2E_DIR**: Test suites under src/__tests__/e2e spawn the bundled CLI from dist/, so they require a build.
- **vitest.config INTEGRATION_DIR**: Test suites under src/__tests__/integration drive src/ services against real git and need no build.
- **vitest.config projects**: pnpm test runs all projects; pnpm test:unit (unit and integration) needs no build, while pnpm test:e2e builds first. unit-project-build-free.test.ts enforces that only suites under the e2e directory use dist/.

### Tests

Why the tests that pin these decisions are built the way they are.

#### `src/__tests__/cli-sync-errors.test.ts`

- **cli-sync-errors.test beforeEach**: vi.clearAllMocks keeps mock implementations, so the service-constructor mock is explicitly reset between tests because some tests make it throw.

#### `src/__tests__/e2e/auth-prompt-disabled.e2e.test.ts`

- **auth-prompt-disabled.e2e runCli**: The auth-prompt e2e test removes every credential source (fresh HOME, no system config, no askpass, no GIT_CONFIG_*, no inherited GIT_TERMINAL_PROMPT) so the CLI itself must disable the prompt. It spawns asynchronously rather than with spawnSync because the 401 HTTP server lives in the test process and must stay responsive while git talks to it.
- **auth-prompt-disabled.e2e runCli**: The 45 s SIGKILL timer in the auth-prompt e2e test is only a backstop: without GIT_TERMINAL_PROMPT=0 and with a terminal attached, git would wait on its credential prompt until the inactivity timeout.

#### `src/__tests__/e2e/clone-init-crash-window.e2e.test.ts`

- **clone-init-crash-window.e2e realGit**: The real git path is resolved in beforeEach rather than at module load, so a missing git fails as a test instead of erroring the whole file at collection time.
- **clone-init-crash-window.e2e git shim**: The git shim execs real git for everything except the remote.origin.fetch narrowing, where it kills the CLI. It triggers on the `--get-regexp` read (the only read the CLI issues) as well as the `--replace-all` write, because a fresh `--single-branch --no-tags` clone already holds the narrowed values and is never written to.
- **clone-init-crash-window.e2e runCli**: The CLI spawn timeout is set below the suite timeout so a hung CLI surfaces as the spawn timing out rather than as an opaque vitest timeout.
- **clone-init-crash-window.e2e**: A SIGKILLed run never releases its repo lock and locks only expire after LOCK_STALE_MS (ten minutes), so the test deletes the lock dir; lock staleness is not under test.

#### `src/__tests__/e2e/clone-mode.e2e.test.ts`

- **clone-mode.e2e growRemote**: The clone-mode e2e helper growRemote pushes empty commits because the shallow-depth tests need history length, not content; it returns the working clone so a test can go on to rewrite that history.
- **clone-mode.e2e growRemoteWithMerges**: growRemoteWithMerges grows main by merged two-commit pull requests (--no-ff), the commonest real main-branch shape and the one that separates commit count from ancestry levels: each round adds three commits but one level.
- **clone-mode.e2e shallow tests**: Shallow-clone e2e tests grow the remote beyond the first deepen target (50 levels) because a shorter remote would be completed by the deepen, and a clone that is no longer shallow is not the case under test.
- **clone-mode.e2e force-push cap test**: The force-push cap test grows the remote well past the first deepen target so the rewritten tip's ancestry is clearly bigger than the window the clone holds, making a missing cap observable.
- **clone-mode.e2e force-push cap test**: A deepen on the first advance doubles as proof that the sync fetch is capped: without --depth the fetch would pull the tip's whole ancestry and never need to deepen.
- **clone-mode.e2e linked worktree test**: The linked-worktree fixture switches the primary clone off main first because git allows a branch to be checked out in only one worktree.
- **clone-mode.e2e linked worktree test**: The linked-worktree test asserts the owner has a second remote-tracking ref before running, because without one to lose the assertions would pass even with the primary-checkout guard removed.

#### `src/__tests__/e2e/concurrent-runs.e2e.test.ts`

- **concurrent-runs.e2e LOSER_EXIT_BUDGET_MS**: LOSER_EXIT_BUDGET_MS bounds how long the test waits for either CLI to exit before releasing the parked fetch, so a broken lock cannot hang the run. Passing runs never pay it (the loser exits in about a second); reaching it is asserted as a failure, so a slow runner yields a false failure, never a false green.
- **concurrent-runs.e2e PARK_OBSERVATION_BUDGET_MS**: PARK_OBSERVATION_BUDGET_MS bounds how long the test looks for a parked fetch after the loser exits; the winner is already parked or nearly so, so only a broken arrangement pays it in full.
- **concurrent-runs.e2e**: Two real CLI processes are the only arrangement that exercises the cross-process lock (in-process tests short-circuit it). Contention is made deterministic: a git shim parks every fetch until a gate file appears, written only after one process exits, so the first lock holder keeps the lock while the other is alive. The test asserts the shim actually parked a fetch, so a shim that stopped engaging (noexec tmpdir, unrecognised invocation) cannot silently turn it back into a race that still passes.
- **concurrent-runs.e2e beforeEach**: Paths are reset before anything in beforeEach can throw because afterEach runs even when the hook fails, and it must not act on paths from a previous iteration.
- **concurrent-runs.e2e beforeEach**: The test deletes SYNC_WORKTREES_LOCK_DIR because the lock path is derived from the canonical worktreeDir, and an inherited override would move both children off the directory the test asserts.
- **concurrent-runs.e2e git shim**: The fetch-parking shim has its own cap so a crashed test never leaves git waiting, and logs before waiting so the test can read evidence while the fetch is parked. It extracts the subcommand from argv because simple-git puts `-c key=value` pairs before it when a config array is passed, and its case patterns use a leading parenthesis because macOS /bin/sh (bash 3.2) otherwise reads `)` as closing `$(`.
- **concurrent-runs.e2e afterEach**: afterEach opens the gate before killing the CLIs because the shim is a shell loop in a grandchild that killing the CLI would orphan; an open gate ends it immediately.
- **concurrent-runs.e2e afterEach**: Temp-dir removal is guarded because if mkdtemp threw there is nothing to remove, and fs.rm(undefined) would bury the real failure under ERR_INVALID_ARG_TYPE.
- **concurrent-runs.e2e childEnv**: Children run with NODE_ENV=production like a daemon or cron tick so the test does not depend on vitest's environment. SYNC_WORKTREES_LOCK_DIR is dropped so both derive the asserted lock path and PATH gets the shim; the inherited SYNC_WORKTREES_UNIT_TEST is harmless because its value is the vitest worker's pid and never matches a child.
- **concurrent-runs.e2e waitForParkedFetch**: By the time the loser exits the winner is parked or a couple of git subprocesses away, so waitForParkedFetch returns almost immediately when the arrangement holds and returns 0 only when nothing parks fetches.
- **concurrent-runs.e2e**: The test clones once up front so both contenders reach the lock with the same work ahead, which is the daemon-plus-cron-tick case the lock exists for.
- **concurrent-runs.e2e**: Parked fetches are counted before the gate opens, because afterwards every fetch passes through and a later count says nothing about the contention.
- **concurrent-runs.e2e**: The test asserts a fetch was parked before asserting the outcome: with nothing parked, nothing held the lock across the other process's lifetime, and any result came from racing.

#### `src/__tests__/e2e/diverged-branch-reservation.e2e.test.ts`

- **diverged-branch-reservation.e2e**: The test removes the replacement worktree with `git worktree remove` so git keeps no stale registration and the original path is genuinely free, isolating the reservation logic from stale-registration handling.

#### `src/__tests__/e2e/headless-cli.e2e.test.ts`

- **headless-cli.e2e**: The headless CLI e2e tests reproduce systemd, docker, CI and `< /dev/null` runs simply by spawning the built bin: a spawned child's stdio is pipes, never a TTY.

#### `src/__tests__/e2e/incomplete-clone-checkout.e2e.test.ts`

- **incomplete-clone-checkout.e2e fixture**: The fixture places a second LFS pointer file inside pkg/ and a plain file in other/, so a cone-mode sparse config can keep the LFS file in the cone while leaving something else out.
- **incomplete-clone-checkout.e2e installFakeLfsFilter**: The fake LFS smudge filter can honour GIT_LFS_SKIP_SMUDGE=1 by passing pointers through, standing in for git-lfs. It is installed via GIT_CONFIG_GLOBAL because clone mode has no repository to configure before cloning, which is also where `git lfs install` puts it.
- **incomplete-clone-checkout.e2e installFakeLfsFilter**: The fake LFS filter sets `clean = cat`, mirroring git-lfs turning a file back into its pointer, because without a clean driver a required filter makes every `git status` fail.

#### `src/__tests__/e2e/lfs-smudge-clone-merge.e2e.test.ts`

- **lfs-smudge-clone-merge.e2e fixture**: README-old.md sorts before the LFS path, so the incoming commit's deletion of it is applied before git gives up; it is the half of the half-applied checkout the cleanup must restore rather than delete.
- **lfs-smudge-clone-merge.e2e installFakeLfsFilter**: The fake LFS smudge filter either honours GIT_LFS_SKIP_SMUDGE=1 by writing the pointer (like git-lfs) or has no escape hatch; it is configured through GIT_CONFIG_GLOBAL, where `git lfs install` also puts it.
- **lfs-smudge-clone-merge.e2e installFakeLfsFilter**: The fake LFS filter sets `clean = cat`, mirroring git-lfs turning a file back into its pointer, because a required filter without a clean driver makes every `git status` fail.
- **lfs-smudge-clone-merge.e2e pushLfsCommit**: The failing upstream commit puts a plain file, a symlink, a dangling symlink and a tracked-file removal before the LFS path in sort order, so git writes all of them before giving up. Symlinks matter because `hash-object` follows them and dies on a dangling one, so they cannot be proved by hashing.
- **lfs-smudge-clone-merge.e2e git helper**: The test's git helper runs with the same GIT_CONFIG_GLOBAL filter config the CLI saw, so `git status` classifies the working tree exactly as the tool's own status call did.

#### `src/__tests__/e2e/lock-unavailable.e2e.test.ts`

- **lock-unavailable.e2e**: The test holds the worktreeDir lock from its own process with proper-lockfile and realpath:false, as the CLI does, so the child contends for the same lockfile.
- **lock-unavailable.e2e**: The contending child runs with HOME and XDG_STATE_HOME different from the holder, as a shell-launched run would, to prove neither moves it onto a different lock file.

#### `src/__tests__/e2e/node-env-independence.e2e.test.ts`

- **unit-test shortcut (SYNC_WORKTREES_UNIT_TEST)**: The built CLI takes the cross-process lock, reaps expired trash and runs gc regardless of NODE_ENV. The unit-test shortcut env var holds the vitest worker's pid and is honoured only by a process whose pid matches, so inheriting it never disables safety features in a child CLI.
- **unit-test shortcut (SYNC_WORKTREES_UNIT_TEST)**: Only a SYNC_WORKTREES_UNIT_TEST value equal to the process's own pid activates the shortcut, so the test sets it from a wrapper module inside the child before importing the CLI entry point.

#### `src/__tests__/e2e/skip-lfs-global-ignore.e2e.test.ts`

- **skip-lfs-global-ignore.e2e fixture**: feature-1 sits on main's tip so once its remote ref is gone nothing on it can read as unpushed, leaving only the untracked-file check to decide whether it is pruned.
- **skip-lfs-global-ignore.e2e runCli**: The child runs with HOME set to the temp home so git reads ~/.config/git/ignore there, with XDG_CONFIG_HOME and GIT_CONFIG_GLOBAL removed so inherited values cannot redirect the lookup or core.excludesFile.

#### `src/__tests__/e2e/sparse-cone-load-validation.e2e.test.ts`

- **sparse-cone-load-validation.e2e**: The accepted-include test is the control: without it, a 'no worktree add in the trace' assertion would also pass on a run that never traced anything.

#### `src/__tests__/e2e/ssh-prompt-disabled.e2e.test.ts`

- **ssh-prompt-disabled.e2e runCli**: The 45 s SIGKILL timer in the ssh-prompt e2e test is only a backstop: without the askpass fix the stand-in ssh waits on its terminal until the inactivity timeout.

#### `src/__tests__/e2e/sync-dry-run.e2e.test.ts`

- **sync-dry-run.e2e snapshot**: The dry-run e2e snapshot records every file under a root as a content hash (symlinks by their target) plus every directory, with an ignore predicate for paths the documented fetch write may touch.
- **sync-dry-run.e2e snapshot**: A pruning fetch rewrites packed-refs when the dropped ref was packed, so the snapshot excludes packed-refs' refs/remotes lines as fetch-owned while still comparing the rest of the file.
- **sync-dry-run.e2e fetchOwned**: The dry-run fetch may change only remote-tracking refs, their reflogs, fetched objects and FETCH_HEAD; everything else in the bare repository (local branches, config, worktree registrations and their indexes) must be unchanged.

#### `src/__tests__/helpers/symlink-support.ts`

- **symlinksSupported**: symlinksSupported probes whether the host can create a symlink (Windows needs Developer Mode or elevation); tests about link targets skip without one instead of faking it. The probe uses the real fs via vi.importActual because callers mock fs/promises to varying degrees and the probe must not be under test.

#### `src/__tests__/helpers/undeletable-file.ts`

- **mockUndeletableFile**: mockUndeletableFile fakes one file the process cannot unlink (foreign uid, immutable attribute, overlay/FUSE EPERM). It reproduces the blast radius faithfully: Node's recursive rm is not a transaction, so every sibling not leading to the survivor is really deleted before the call rejects with EPERM. Test files must install a partial fs/promises module mock because ESM namespace exports cannot be spied on.

#### `src/__tests__/index.daemon.test.ts`

- **runMultipleRepositories daemon tests**: The daemon-mode tests of runMultipleRepositories mock InteractiveUIService on purpose: the real one renders an Ink tree and registers cron jobs that outlive the call, leaving handles that hang the run, and it has its own tests. What is under test is index.ts's side of the boundary (one service per repository, UI constructor arguments, schedule summary, shutdown hook), visible only as arguments passed and calls made.
- **index.daemon.test mocks.callOrder**: The daemon tests record every addLog line and the startup sync in one ordered list, because the summary lines count as 'first' only if nothing can overtake them.
- **index.daemon.test mocks.uiConstructions**: The InteractiveUIService mock returns a fresh object per construction and records each with its arguments, because a single shared spy would report the same calls whether the daemon built one UI service or five.
- **index.daemon.test InteractiveUIService mock**: The fake triggerInitialSync returns a promise because index.ts leaves it unawaited (`void`), and `void` on a non-promise would be a different statement; initialSyncGate lets a test hold the promise open.
- **index.daemon.test maxRepositories**: The maxRepositories override tests use values (5 and 7) asserted to differ from the built-in default, so neither can pass by falling back.
- **index.daemon.test schedule summary**: The schedule summary is asserted as the complete ordered list of lines, because a dropped schedule, a double count or a misattributed count all pass per-line toContain checks.
- **index.daemon.test startup sync**: The test proves runMultipleRepositories returns before the startup sync settles by ordering, not timing: two setImmediate turns settle everything it does not await while anything awaited waits on release(), so a slow CI runner cannot change the outcome.

#### `src/__tests__/index.run-once.test.ts`

- **index.run-once.test WorktreeSyncService mock**: The WorktreeSyncService mock passes the repository name to its spies so a test can fail one repository's initialization while others succeed, as in a parallel run. It exposes no initialize() because run-once leaves initialization to sync().
- **index.run-once.test initialization failure**: The test asserts the repositories that initialized fine are not named, because reading the wrong allSettled index would still interpolate some name and pass a positive-only check.

#### `src/__tests__/init-round-trip.test.ts`

- **init-round-trip.test**: The init round-trip tests mock only the interactive surface; the config generator and loader are real, because the point is that `init` proves the file it just wrote actually loads.
- **init-round-trip.test**: hasInteractiveTerminal is mocked because the init wizard refuses to start without a terminal and vitest's stdin is not one.

#### `src/__tests__/integration.test.ts`

- **integration.test rawDefault**: The integration test's bare-repo stand-in reports the default-branch worktree as registered so initialize() reuses it instead of creating one; every other raw call is a no-op.
- **integration.test mixed operations**: The mixed add/remove/skip integration test disables trash so it asserts the direct `worktree remove` mechanism; the trash pipeline has its own suites.

#### `src/__tests__/integration/branch-wizard-stale-remote.test.ts`

- **branch-wizard-stale-remote.test**: The branch-wizard stale-remote tests stub only Ink's render; InteractiveUIService, WorktreeSyncService, GitService, simple-git and git are real, against a real local bare remote, because the claim is that a remote ref does not move.
- **branch-wizard-stale-remote.test fixture**: The fixture leaves `hotfix` on a 45-day-old commit that is an ancestor of everything main gains later, the exact shape a plain push would fast-forward, and old enough for branchMaxAge to filter it out.
- **GitService.pushBranch**: The remote probe and the push lease are independent defences, and the wizard-level tests pass with either. The lease must hold when the probe cannot (offline, where probe failure is deliberately non-fatal, or a ref created between probe and push), so a dedicated test creates the local branch with raw git and calls pushBranch directly.
- **branch-wizard-stale-remote.test lease test**: A control push of a name origin does not have must succeed, showing the lease refuses the existing ref rather than pushes in general.

#### `src/__tests__/integration/clone-branch-wizard.test.ts`

- **clone-branch-wizard.test**: The clone-mode branch wizard tests stub only Ink's render; InteractiveUIService, WorktreeSyncService, CloneSyncService, simple-git and git are real.

#### `src/__tests__/integration/default-branch-rename.test.ts`

- **default-branch-rename.test pushTrunk**: The fixture pushes the new default at main's tip plus one commit so a worktree at origin's tip is distinguishable from one at main's.
- **default-branch-rename.test retireMain**: Retiring the old default on the remote moves the bare repository's HEAD first, because git refuses to delete a bare repository's current branch.

#### `src/__tests__/integration/detached-worktree-create.test.ts`

- **detached-worktree-create.test fixture**: The fixture puts two commits on feature-x so the worktree can be detached onto the older one and any move away from it is visible.

#### `src/__tests__/integration/force-clean-object-reclaim.test.ts`

- **force-clean-object-reclaim.test makeUnreferencedCommit**: The fixture creates unpushed work with `commit-tree` rather than creating and deleting a branch, so the only thing that ever points at the commit is the ref the test places.
- **force-clean-object-reclaim.test fixture**: The `gone` branch carries a commit of its own, so after its remote branch is deleted the trash pin ref is the only ref reaching it, making its collection observable.
- **force-clean-object-reclaim.test config**: trash.migrateLegacy is off because legacy adoption would move the .diverged/ backup into the trash and retire its keep ref, a different flow; the test is about a backup force clean finds still in place.
- **force-clean-object-reclaim.test config**: maintenance.aggressive gives `gc --prune=now`; the default forced run prunes on a one-hour mtime window (covered by the maintenance e2e), and here only reachability at collection time matters, so nothing depends on file timestamps.

#### `src/__tests__/integration/force-clean-snapshot.test.ts`

- **force-clean-snapshot.test fixture**: `shown-first` carries no commits of its own; it is trashed before the preview only so the preview has an entry to count.
- **force-clean-snapshot.test fixture**: `unseen-later` carries a commit that exists nowhere else once its remote branch is deleted, so its trash pin ref is the only thing keeping it through gc, making an over-broad purge observable.

#### `src/__tests__/integration/git-maintenance.test.ts`

- **git-maintenance.test backdateObjects**: backdateObjects ages every file in the object store, including the pack a cruft pack copies its recorded mtimes from, to stand in for objects a developer wrote long before a recovery ref holding them is purged.
- **git-maintenance.test grace window**: The grace-window tests use 55 and 65 minutes rather than days and minutes, so widening the window to a day or narrowing it to half an hour fails a test instead of the value only ever being asserted against a copy of itself.
- **git-maintenance.test fresh pack**: A dedicated test covers old commits inside a freshly written pack, a shape backdateObjects cannot produce because it ages packs too; without it the documented caveat would have no evidence.
- **git-maintenance.test fresh pack**: The fixture repacks while the commit is still reachable so it lands in an ordinary pack; a cruft pack records per-object mtimes and would carry the old age across.
- **git-maintenance.test grace window**: The 55-minute case is the other half of the bracket: a window narrowed to seconds, too short to outlast one `git commit` (what it exists to protect), fails it, while a window widened to a day fails the 65-minute case.

#### `src/__tests__/integration/head-branch-worktree.test.ts`

- **head-branch-worktree.test ensureOriginHeadSymref**: `git remote set-head` writes origin/HEAD and a fresh `clone --bare` may lack it, so the test creates the symref explicitly; the exclusion is only exercised while it exists.
- **head-branch-worktree.test**: The fixture creates a remote branch and a worktree for it outside sync, as the TUI wizard and MCP create_worktree do; it is clean and fully pushed, so only the branch inventory stands between it and the trash.

#### `src/__tests__/integration/inherited-git-dir.test.ts`

- **withForeignRepoInEnv**: The foreign repository variables are set in the environment only while the sync tick runs and are restored before assertions, so the verification git probes are not themselves redirected by the variables under test.
- **inherited-git-dir test**: Object absence is checked with `git cat-file -t` rather than `-e` because simple-git resolves a non-zero exit with empty stderr as success, which is exactly what `-e` produces for a missing object, so an `-e` assertion would pass regardless.

#### `src/__tests__/integration/lfs-smudge-worktree-create.test.ts`

- **installFakeLfsFilter**: The fake LFS filter's honorsSkipEnv mode emulates real git-lfs, which checks out pointer files instead of failing when GIT_LFS_SKIP_SMUDGE=1 is set.
- **installFakeLfsFilter**: The fake filter.lfs section is appended directly to the bare repository's config file because simple-git refuses to set filter.* keys; that is also where `git lfs install` would write them.
- **lfs-smudge-worktree-create test**: The broken LFS filter is configured only after the first sync has built the bare repository and default worktree, mirroring a user whose global git-lfs install is already present when a branch needing LFS appears.

#### `src/__tests__/integration/lfs-smudge-worktree-update.test.ts`

- **installFakeLfsFilter**: The fake LFS filter's honorsSkipEnv mode emulates git-lfs writing pointer files under GIT_LFS_SKIP_SMUDGE=1; it is written into the bare repository's config because every linked worktree shares that config.
- **pushLfsCommit**: The LFS update test commit adds, modifies and deletes files that all sort before the LFS asset, so a failing smudge leaves a half-applied checkout that the sync must roll back.
- **lfs-smudge-worktree-update sparse test**: The sparse-checkout LFS test places the LFS file outside the initial cone so the fast-forward never smudges it and only the widening `sparse-checkout set` triggers the failure.

#### `src/__tests__/integration/local-op-inactivity-timeout.test.ts`

- **useSlowGit**: The slow-git shim is injected by prepending it to PATH because createGitClient hands each child the sanitized process environment, so the shim reaches every git the service spawns afterwards.
- **local-op-inactivity-timeout setup**: The bare repository is prepared with plain git before the slow shim is installed, so only the commands under test experience the artificial silence.
- **ENV_CONSTANTS.UNIT_TEST_SHORTCUT**: The unit suite disables git inactivity timeouts process-wide through the unit-test shortcut environment variable, so tests that exercise those timeouts must delete it before running.
- **local-op-inactivity-timeout config-file tests**: Timeout tests build GitService through ConfigLoaderService from a real config file rather than a hand-built Config, because the loader once rebuilt repository config from an allowlist that dropped fetchTimeoutMs and cloneTimeoutMs, and hand-built configs could not catch that.
- **useSlowNetworkGit**: The config loader only accepts a non-zero timeout window of at least one second, so config-file timeout tests use a 1 s window behind a shim silent for 1.5 s, applied only to fetch and clone so local commands do not pay the delay.
- **cloneTimeoutMs config-file test**: The clone-timeout test points at a bare repository that does not exist so initialize() must clone, the only command on the clone budget, and disables fetchTimeoutMs so nothing else can produce a block timeout.

#### `src/__tests__/integration/locked-worktree-prune.test.ts`

- **locked-worktree-prune setup**: The locked-worktree prune test gives feature/a no commits of its own so nothing but the lock can prevent its removal once the remote branch is deleted.

#### `src/__tests__/integration/paused-rebase-unpushed.test.ts`

- **paused-rebase-unpushed setup**: The paused-rebase fixture makes two local-only commits where the first replays cleanly and the second conflicts, so the paused HEAD holds exactly one replayed local-only commit.

#### `src/__tests__/integration/per-worktree-stash.test.ts`

- **per-worktree-stash setup**: The per-worktree stash test pushes feature branches with no commits of their own, so each stays fully pushed after its remote branch is deleted and only a stash can block its prune.
- **setUpWorktrees**: git stash needs a committer identity, and repository config is shared by every linked worktree, so setting user.name and user.email once in the main worktree covers stashing in all of them.

#### `src/__tests__/integration/stale-directory-quarantine.test.ts`

- **stale-directory-quarantine setup**: The stale-directory test pushes both feature/a and feature-a, which flatten to the same plain name, so both get hashed directories and a stray directory at that hashed path can only be there because someone put it exactly there.

#### `src/__tests__/integration/trash-restore-after-gc.test.ts`

- **trash-restore-after-gc setup**: The gc restore test gives `feature` a commit of its own so that, after its remote branch is deleted, the trash pin is the only ref anywhere pointing at that commit.
- **trash-restore-after-gc missing-commit test**: Deleting the pin ref and running gc simulates what a failed pin-ref delete during an earlier restore, or a hand-emptied ref namespace, leaves behind: a manifest naming a commit the object store no longer has.

#### `src/__tests__/integration/uninitialized-submodule-prune.test.ts`

- **uninitialized-submodule-prune setup**: The submodule gitlink is written with `git update-index --cacheinfo 160000,...` instead of `git submodule add`, which would need a file-protocol allowance and a local checkout; recording the gitlink entry is enough for git to report the submodule as uninitialized.
- **uninitialized-submodule-prune setup**: The submodule prune test gives feature/a no commits of its own so it stays fully pushed after its remote branch is deleted, leaving only the submodule marker as a possible blocker.

#### `src/__tests__/integration/unshallow-inactivity-timeout.test.ts`

- **useSlowGit**: The slow-git shim is injected by prepending it to PATH because createGitClient hands each child the sanitized process environment, so the shim reaches every git the service spawns afterwards.
- **unshallow-inactivity-timeout setup**: The shallow clone a configured depth would produce is made with plain git before the shim is installed, so only the unshallow fetch runs slowly.
- **unshallow slow-git shim**: The slow shim runs its sleep in the background under an INT/TERM trap because dash exits on the timeout's SIGINT, but bash (macOS's /bin/sh) waits out a foreground child and then continues to the real git, which would defeat the timeout.
- **ENV_CONSTANTS.UNIT_TEST_SHORTCUT**: The unit suite disables git inactivity timeouts process-wide through the unit-test shortcut environment variable, so tests that exercise those timeouts must delete it before running.

#### `src/__tests__/integration/untracked-ignored-status.test.ts`

- **untracked-ignored-status tests**: Spawn-count tests first assert the git shim logged at least one command, because if the shim stopped being seen the negative assertion that check-ignore never ran would pass while proving nothing.
- **untracked-ignored-status tests**: Spawn-count tests first assert the git shim logged at least one command, because if the shim stopped being seen the negative assertion that check-ignore never ran would pass while proving nothing.
- **untracked-ignored-status ARG_MAX test**: The ARG_MAX test writes 3 MiB of untracked paths, past ARG_MAX on both supported platforms (2 MiB on Linux, 1 MiB on macOS), and gets its own 120 s timeout because writing about 44k files can be slow on some filesystems.
- **untracked-ignored-status tests**: Spawn-count tests first assert the git shim logged at least one command, because if the shim stopped being seen the negative assertion that check-ignore never ran would pass while proving nothing.

#### `src/__tests__/integration/update-spawn-budget.test.ts`

- **installGitShim**: The spawn-counting shim has its log path baked into the script rather than read from an environment variable, because simple-git snapshots the environment when it builds a client and a variable set later would never reach the child.
- **update-spawn-budget makeConfig**: Spawn-budget tests disable maintenance because `git gc` is throttled by a persisted timestamp and would add a one-off process to whichever tick happened to run first.

#### `src/__tests__/integration/worktree-client-cache.test.ts`

- **worktree-client-cache test**: The client-cache baseline consists of the bare repository's and the anchor worktree's clients, which outlive every branch; after branch cycles the cache must return to exactly that size.

#### `src/__tests__/integration/worktree-divergence.test.ts`

- **worktree-divergence setup**: `git clone --bare` records no fetch refspec, so remote-tracking refs (what @{upstream} resolves to) never appear unless +refs/heads/*:refs/remotes/origin/* is added explicitly.
- **worktree-divergence setup**: Every fixture branch is main plus its own seed commit, so a branch re-pointed to track local main is exactly one commit ahead of its upstream.
- **worktree-divergence spawn test**: Spawn-count tests first assert the git shim logged at least one command, because if the shim stopped being seen the negative assertions would pass while proving nothing.

#### `src/__tests__/local-ahead-of-remote.test.ts`

- **local-ahead-of-remote suite**: Unit suites that assert the direct-delete removal mechanism set trash.enabled to false; the trash pipeline is covered by its own suites.

#### `src/__tests__/rebased-branch-handling.test.ts`

- **rebased-branch-handling setup**: Removal audit records gate destructive operations and are written as a durable append through fs.open, appendFile and sync on the handle rather than fs.appendFile, so unit tests that reach removal must mock fs.open with a handle exposing those methods.
- **rebased-branch-handling suite**: Unit suites that assert the direct .diverged/ mechanism set trash.enabled to false; the trash pipeline is covered by its own suites.
- **rebased-branch-handling diverged-behind test**: The ahead/behind mock is staged so the Phase 4a probe reports behind, causing a fast-forward attempt, while the re-verify inside diverged handling then reports commits on both sides.
- **probeDivergedThen**: Phase 4a and the diverged-handling re-verify call the same ahead/behind probe, so the mock reports commits on both sides on the first call for the worktree and the scenario-specific result on every later call.

#### `src/__tests__/setup.ts`

- **vitest setup**: NODE_ENV=test is set only for libraries that key off it (React and Ink choose their development builds from it); no sync-worktrees code path branches on it.
- **ENV_CONSTANTS.UNIT_TEST_SHORTCUT**: Each vitest worker opts into in-process unit-test shortcuts (no cross-process repo lock, no git inactivity timeouts, no trash reaping or periodic gc) by setting the shortcut variable to its own pid. Child processes spawned by e2e suites inherit the variable but never match the pid, so the built CLI always runs the real code paths.
- **vitest setup**: Every git spawned by the test suite runs with GIT_CONFIG_GLOBAL=/dev/null and GIT_CONFIG_NOSYSTEM=1, set unconditionally. Host config such as the filter.lfs.process key from Git LFS initialized. makes git ignore the deliberately failing smudge filter the LFS suites install, inverting results on CI runners with git-lfs; suites needing their own global config set it on the child they spawn, which still wins.
- **vitest setup**: Ink v7 measures terminal size through the terminal-size package, which shells out to tput several times per render when stdout is not a TTY, adding about 0.8 s to every component test. terminal-size checks COLUMNS and LINES first, so the setup provides defaults to keep rendering spawn-free.

#### `src/__tests__/test-utils.ts`

- **setEnvVar**: process.env coerces every assignment to a string, so restoring a variable that was originally unset must delete it rather than assign undefined.

#### `src/__tests__/trash-cli.test.ts`

- **trash-cli afterEach**: The trash CLI reports expected failures through process.exitCode, so tests must restore the original value afterwards or the vitest run itself would exit as failed.
- **trash-cli listing test**: An orphaned trash entry has no branch or pin, so its row falls back to its original path. The test id deliberately shares no substring with the directory name or reason, so the row assertions cannot pass without the columns actually being rendered.
- **trash-cli size test**: The unmeasured-size test first asserts both rows are printed, so the assertion that no 0 B appears cannot pass for a listing that printed nothing.
- **trash-cli purge gate test**: The purge-gate test makes the trash entry exist so the refusal must come from the TTY gate rather than from no trash entry with that id.

#### `src/__tests__/unit-project-build-free.test.ts`

- **unit-project-build-free test**: The build-free check first asserts the pattern matches at least one e2e suite, because if the e2e suites stopped matching it the placement checks would prove nothing.

#### `src/components/__tests__/App.test.tsx`

- **App log batching test**: The log-burst test allows up to three frames for one flush, giving slack for a slow machine that splits the burst across two flush intervals.

#### `src/components/__tests__/ForceCleanModal.test.tsx`

- **ForceCleanModal tests**: The force-clean modal box wraps at 78 columns, so frame assertions match phrases or words on either side of line breaks rather than whole sentences.
- **ForceCleanModal tests**: The force-clean modal box wraps at 78 columns, so frame assertions match individual words or whitespace-tolerant patterns rather than whole sentences.

#### `src/components/__tests__/HelpModal.test.tsx`

- **HelpModal tests**: The quit-row help test renders with 40 available rows because at 24 rows the help sheet scrolls and the quit row is cut off.

#### `src/components/__tests__/LogPanel.test.tsx`

- **LogPanel tests**: In the app the LogPanel scroll position is owned by App and passed down via useLogScroll, so the LogPanel tests wrap LogPanelView in a small component that calls useLogScroll itself to stand in for App.
- **LogPanel mouse wheel tests**: The wheel-scroll tests use 40 log entries in a 7-line viewport so that a single wheel notch (3 lines) visibly changes which entries are on screen.

#### `src/components/__tests__/StatusBar.test.tsx`

- **StatusBar tests**: Under vitest fake timers the StatusBar timer callback fires, but the resulting Ink re-render is scheduled on the real event loop, so the test must poll with vi.waitFor instead of asserting right after advancing timers.

#### `src/components/__tests__/terminal-size.ts`

- **resizeTerminal**: The ink-testing-library stdout always reports 100 columns and no rows, so Ink's height falls back to the environment's terminal size. Layout tests therefore pin both columns and rows on the stdout and emit a resize event so Ink re-measures.

#### `src/mcp/__tests__/context.broken-config.test.ts`

- **context.broken-config tests**: The broken-config fixture uses unbalanced braces so every JavaScript parser rejects it with a parse error rather than a missing-field message. node --check is deliberately not used to assert brokenness, because it reports on the file it is given, not on what the module system does with it.
- **context.broken-config tests**: The broken-config tests recover the loader's actual rejection message from the spy instead of hard-coding parser wording, because inside vitest the first evaluation of a path goes through Vite, whose parse error differs from Node's.
- **context.broken-config tests**: The same-size-edit test pins the config's mtime to a whole second so mtimeMs can be restored exactly after the edit; restoring stat.mtime as a Date truncates the sub-millisecond precision ext4 stores, which would release the gate on mtime and never exercise the content hash.
- **context.broken-config tests**: The test edits one character keeping the byte count identical, the case a stat-only gate misses on filesystems whose mtime resolution is coarser than the edit.
- **context.broken-config tests**: The touch-only test asserts that fs.stat reports a newer mtime after utimes, guarding against coarse-resolution filesystems where the premise would not hold.

#### `src/mcp/__tests__/context.nested-repo.test.ts`

- **context.nested-repo tests**: The nested-repo tests add submodules with child_process rather than simple-git, because simple-git's unsafe-operations plugin rejects both the protocol.file.allow override a file:// submodule needs and the GIT_EDITOR the environment exports.
- **context.nested-repo tests**: The submodule test asserts the actual gitdir pointer git wrote rather than assuming it, and matches the whole resolved path so the fixture's temporary directory name cannot satisfy the check by accident.

#### `src/mcp/__tests__/context.test.ts`

- **context tests**: The HEAD-mtime test asserts fs.stat reports a newer mtime after utimes, guarding against coarse-resolution filesystems where the premise would not hold.
- **context tests**: The bounded-cache test asserts the cache holds more than one entry as well as fewer than the probed paths, because a cache that never cached anything would also satisfy the ceiling.

#### `src/mcp/__tests__/create-worktree-prune.test.ts`

- **create-worktree-prune tests**: The create_worktree prune tests fake only the RepositoryContext pieces the handler uses (repository selection, capability verdict and the service); everything else runs against real git.
- **create-worktree-prune tests**: The included-branch test configures filters that the branch passes, so a guard that is over-broad within the filter path (refusing a branch branchInclude keeps) fails, not only one that refuses everything.

#### `src/mcp/__tests__/create-worktree-retry.test.ts`

- **makeRemoteRejectPushes**: A pre-receive hook that always exits 1 is installed in the test remote to make a real git push fail, because it is the only reliable way to do so without touching the network or filesystem permissions.

#### `src/mcp/__tests__/handlers.capability-gate.test.ts`

- **capability gate tests**: The capability gate tests drive the real RepositoryContext against a temporary worktree fixture and mock only git and WorktreeSyncService, so the gate is exercised end to end without touching a real repository.
- **makeService**: The WorktreeSyncService double delegates getWorktrees to the git service double, mirroring the real service in worktree mode, so each test only needs to override the git listing.

#### `src/mcp/__tests__/handlers.context-flows.test.ts`

- **handlers context-flow tests**: Other MCP handler suites pass a hand-written ctx, which leaves detection, the discovery cache, repository selection and capability derivation untested from the handler side. The context-flow suite uses the real RepositoryContext and real WorktreeSyncService against a temporary fixture, faking only simple-git, WorktreeSyncService.sync, isInitialized and getGitService. Every flow also parses the tool's advertised output schema, because the SDK turns a schema-violating structuredContent into an error; the schemas are loose, so the parse catches missing or mistyped required fields but not extra ones.
- **simple-git mock**: The simple-git double's env() returns the client itself, because createGitClient returns the result of .env() and that value must be the usable client.
- **readResult**: The test helper reading a tool result checks a success result against the schema the server advertises, and also compares structuredContent with the JSON text block, because the SDK sends both and a client may read either.
- **handlers context-flow tests**: WorktreeSyncService.isInitialized is stubbed to true in the context-flow suite so nothing reaches the real initialize(), which would clone over the network; the flows themselves decide when a repository counts as cloned.
- **repoBlock**: Each repository entry in the context-flow fixtures gets its own repoUrl, because two entries sharing a URL make the config loader emit a reorder-proofing warning that is noise for these tests.

#### `src/mcp/__tests__/handlers.test.ts`

- **handlers.test fs mock**: create_worktree probes its target path on disk through probePathExists (fs.access). The handler suite's fake worktree tree never exists, so fs.access defaults to rejecting with ENOENT and target-path tests override it per call.
- **statusProbes**: The fake status service records every path it is asked about in call order, one entry per probe, so a worktree listed twice in a detect_context response shows up twice unless the handler deduplicated the probes.
- **FakeRefScanScope**: The RefScanScope fake is an empty class because handlers only pass it through to the status probes untouched; the fake status service never scans refs.
- **makeCtx resolveNewWorktreePath**: The mock resolveNewWorktreePath always returns the plain sanitized name under the mock worktreeDir, unlike the real one which also weighs sibling branches and what is on disk.
- **makeCtx**: The test ctx factory checks discovered === undefined rather than using ??, because a test passing discovered: null is asking for the no-detected-context branch and ?? would silently substitute a full context, leaving the fallback error path untested.
- **parseResponse**: Every MCP tool advertises an outputSchema, so the test helper asserts that each success result also carries structuredContent equal to its text body; the SDK turns a result that omits structuredContent into an error.
- **progress reporter tests**: The transfer-stream test builds its events with the real makeGitProgressHandler that the git clients use, so the events carry exactly the shape production produces.
- **detect_context dedup test**: The dedup test feeds distinct objects carrying the same paths, exactly as the two separate git reads produce them, so deduplication must key on path rather than object identity.

#### `src/mcp/__tests__/read-only-index.test.ts`

- **read-only index tests**: The fixture backdates a tracked file's mtime so it is stat-dirty but content-clean; a plain git status would refresh the index in that state, which is what the test must detect.

#### `src/mcp/__tests__/update-worktree-detached.test.ts`

- **advanceRemote**: The detached-worktree tests add a second commit on origin so an update that actually ran would visibly move HEAD; otherwise a suppressed fast-forward and a performed one look the same.
- **update_worktree detached tests**: The test asserts that git lists the path without a branch so it cannot silently stop being about a detached worktree, and anchors the detached match to a whole line because the temp directory's name also contains the word.

#### `src/services/__tests__/bare-repo.service.test.ts`

- **mockBareRepoState**: The fs stand-in for bare clone recovery is keyed by path: only bare/HEAD, the bare directory and the marker answer differently. The marker is tracked for real through writeFile and unlink so the order the code writes and clears it is observable, and a failing clone can leave a partial directory behind.
- **detectDefaultBranch tests**: The test calls detectDefaultBranch on the BareRepoService that GitService delegates to, so detection runs with the same logger and cached network client that initialize uses.

#### `src/services/__tests__/branch-created-actions.service.test.ts`

- **BranchCreatedActionsService.runHooks tests**: Hook logging tests drive the real HookExecutionService and real child processes, because the log line is the deliverable and nothing should stand in for what produces it.

#### `src/services/__tests__/branch-ref.branch-config-cleanup.test.ts`

- **branch config cleanup tests**: Real-git coverage of branch config cleanup lives elsewhere, but real git fails the removal only one way and always quickly. These mock tests pin the two properties real git cannot reach: the catch covers every error, not only git errors, and the removal is awaited, so a successful branch deletion is neither reported as failed nor as finished before its config is cleaned.
- **branch config cleanup tests**: Real git clears the config section in about a millisecond, so a fire-and-forget removal would still pass real-git tests by luck; the test holds the removal open to prove the deletion does not resolve until it finishes.
- **branch config cleanup tests**: The test spins the event loop for many more turns than an un-awaited removal would need to complete, so an unsettled promise afterwards shows the deletion is genuinely waiting on the removal.

#### `src/services/__tests__/branch-ref.ref-argument-separator.test.ts`

- **ref argument separator tests**: The fixture asserts the bare repo's HEAD is a branch ref, because git branch -m renames whatever HEAD points at and a detached bare repo would make the assertions pass for the wrong reason.

#### `src/services/__tests__/branch-ref.remote-ref-inventory.test.ts`

- **remote ref inventory tests**: The fixture pushes branch names git prints in surprising shapes: one ending in /HEAD, one named origin, one containing a pipe, and one whose short form collides with a local branch created later.

#### `src/services/__tests__/clone-branch-wizard.real-git.test.ts`

- **clone branch wizard tests**: The clone-mode branch wizard tests stub only Ink's terminal renderer; the services beneath it and git itself are real.

#### `src/services/__tests__/clone-sync.client-timeouts.test.ts`

- **CloneSyncService git client timeout tests**: The unit-test shortcut environment variable zeroes both git inactivity timeouts suite-wide. Tests that distinguish the fetch client from the local client by their timeout must delete the shortcut so the real timeouts apply, and restore it afterwards.

#### `src/services/__tests__/clone-sync.service.test.ts`

- **CloneSyncService tests beforeEach**: vi.clearAllMocks only drops call history, so an implementation one test sets on fs.readdir, fs.access or fs.readFile would leak into later tests and decide which branch of initialize() runs. The suite resets those three mocks before each test so every test states its own filesystem, starting from the automock baseline where every call resolves undefined.
- **CloneSyncService incomplete-marker tests**: The refusal test calls initialize() twice against the same on-disk state, so its readdir stub is persistent rather than a ...Once; a second call falling through to the automock would prove nothing about the refusal.
- **CloneSyncService recovered sparse clone test**: The test asserts that a client is passed to applyToWorktree and that a client was built with GIT_LFS_SKIP_SMUDGE=1, because expect.anything() alone would also pass for the default client, which was the bug.
- **CloneSyncService partial-clone cleanup tests**: Leave-in-place tests assert on every recursive fs.rm wherever it is aimed, not only deletes of the destination, because a filtered assertion cannot see a delete pointed at the parent directory and would report it as clean.
- **CloneSyncService pending marker tests**: The pending-marker test simulates a kill by making the first git write after the clone (the remote narrowing) fail; the on-disk state at that point is a complete adoptable clone, the same as a SIGKILL would leave, so the only question is whether the marker was already written.
- **clone-sync test git double for ls-tree**: The fake `ls-tree` strips the `:(literal)` prefix because real code hands git `:(literal)<path>` pathspecs, so a file name starting with `:` is never read as pathspec magic.

#### `src/services/__tests__/clone-sync.unshallow.test.ts`

- **CloneSyncService unshallow tests**: The unit-test shortcut environment variable zeroes both git inactivity timeouts suite-wide. A suite asserting which timeout the unshallow fetch receives must delete the shortcut so the real timeouts apply.

#### `src/services/__tests__/config-loader.esm-reload.test.ts`

- **config reload under real Node tests**: Under vitest, dynamic import() inside the config loader is served by Vite's module runner, which resolves and caches differently from Node, so an in-process reload test can pass while a real node process keeps serving first-loaded values. The reload tests therefore bundle the loader once with esbuild (the bundler pnpm build uses) and drive it from a child node process. Bundle and fixtures live under os.tmpdir() because a fixture inside the repository would inherit its "type": "module" and change whether a .js config is ESM or CommonJS; node_modules is symlinked in so the bundle's external imports resolve.
- **reloadUnderRealNode**: The reload helper loads a config twice through one ConfigLoaderService instance in one node process, modelling the MCP server, which holds a single loader for its lifetime and reloads on a second load_config. The interactive UI's reload key constructs a fresh loader instead and is tested separately.
- **config reload argv test**: The argv reload test runs its child from a real script file rather than `node -e`, because `node -e` also lacks a script-path slot in process.argv and would hide the off-by-one the test pins.
- **TypeScript configs under real Node tests**: Under vitest, import() is served by Vite, which compiles TypeScript and would accept enums, namespaces and parameter properties, while Node only erases type annotations and rejects syntax that needs code emission. The .ts config tests therefore drive the bundled loader from a child node process. Fixtures sit under os.tmpdir() with no package.json so Node's module-syntax detection treats `export default` as ESM; the "type": "commonjs" case is tested separately.
- **hooks.timeoutMs under real Node tests**: Under vitest the first config load goes through Vite and only later loads through Node's registry, so in-process assertions can accept results a real node run never produces. hooks.timeoutMs is therefore tested through the bundled loader in a child node process, checking that the value survives defaults-to-repository inheritance as a number and that 0 survives as 0 instead of being dropped as falsy.

#### `src/services/__tests__/config-loader.example-config.test.ts`

- **EXAMPLE_REPOSITORY_NAMES**: The example config tests pin every repository name in file order so an entry cannot be silently dropped, or a stray one added, while the file still loads.
- **sync-worktrees.config.example.js tests**: getWorktreeDirLockTarget honours the lock-directory environment override, so the example-config tests unset it to assert the default lock placement the example documents.
- **sync-worktrees.config.example.js tests**: Besides checking that each example key survives into the resolved config, the example is scanned with collectUnknownConfigKeys so that no key at any level, including inside nested blocks the survival check cannot reach, is unknown to the loader.

#### `src/services/__tests__/config-loader.service.test.ts`

- **ConfigLoaderService reload tests**: The in-process .mjs reload test is intentionally duplicated by a real-node child-process test, because under vitest import() runs through Vite's module runner rather than Node's registry. The in-process version is kept as a cheap regression guard for the parts Vite does not touch: the reload worker, the structured clone and the error rebuild.

#### `src/services/__tests__/config-loader.unknown-keys.test.ts`

- **ConfigLoaderService unknown-key tests**: The no-warning test uses a config that sets every user-facing Config key rather than a minimal one, because a small fixture would still pass if the known-key inventory lost half its entries. It omits only runOnce (rejected on a repository entry) and the clone-only and clone-conflicting fields, which a separate clone-mode case covers.

#### `src/services/__tests__/file-copy.service.test.ts`

- **FileCopyService excludeDirs tests**: The metacharacter exclusion test pairs each excluded directory name with a non-excluded sibling the name would match if read as a glob pattern, so mishandling metacharacters either leaks the excluded checkout's file or silently drops the sibling, and both failures are caught.

#### `src/services/__tests__/git-update.test.ts`

- **GitService.updateWorktree tests**: The updateWorktree tests replace the worktree metadata service with a stub because its no-metadata-yet fallback would read HEAD itself and disturb the HEAD read counts; the arguments it receives are asserted directly instead.

#### `src/services/__tests__/git.service.anchor-worktree.test.ts`

- **GitService.ensureAnchorWorktree tests**: The anchor-worktree tests keep probePathExists' real behaviour and only force its "unknown" result through a spy, because a probe failing for a reason other than the path being gone cannot be produced from the filesystem in a suite that may run as root.

#### `src/services/__tests__/git.service.client-cache.test.ts`

- **GitService cached client tests: warmClientsFor**: To populate every cached client for a worktree, the test helper calls checkoutHead (GitService's LFS-skip variant), getCurrentCommit (the plain variant) and checkWorktreeStatus (the status service's separate cache).

#### `src/services/__tests__/git.service.client-timeouts.test.ts`

- **GitService git client timeouts tests**: The suite-wide unit-test shortcut env var zeroes both git timeouts. The client-timeout tests delete it so the real timeouts apply and the local and network client kinds can be told apart.
- **GitService git client timeouts tests**: Each simple-git client gets a fresh progress closure, so the tests compare option key sets rather than deep equality: the network client's options are the local client's plus the block timeout.

#### `src/services/__tests__/git.service.logger-propagation.test.ts`

- **GitService logger propagation tests**: The simple-git mock records the options each client was built with so a cached client's progress handler can be fired the way simple-git fires it.
- **GitService logger propagation tests**: The status mock rejects so that the status service emits its 'Error reading status for' log line, which the tests use to see which logger received it.
- **GitService logger propagation tests**: The metadata file mock returns an empty object so the metadata service logs 'Corrupted metadata for', a real log line the tests trace to the active logger.

#### `src/services/__tests__/git.service.test.ts`

- **GitService tests**: git.service.test.ts covers only GitService's own responsibilities (clients, initialize and the default-branch worktree, fetches, update/reset probes). Delegated behaviour is tested beside each implementing service (bare-repo, branch-ref, worktree-creation, worktree-registry, lfs-verification) but still driven through GitService so the shared clients and settings are exercised.
- **GitService timeouts tests**: The zero-timeout test asserts on every simple-git client built during the call, because asserting that some client lacked a timeout would still pass with a timed client beside it.

#### `src/services/__tests__/helpers/git-service-fixture.ts`

- **createGitServiceFixture**: The shared GitService fixture runs against mocked simple-git and fs/promises, but vi.mock calls are hoisted per file, so each test file using it must still declare its own mocks for fs/promises, simple-git and the worktree metadata service (via the metadata-service-mock helper).
- **createGitServiceFixture**: The git-lfs availability probe and its 'not installed' warning are latched per process, so the fixture resets them before each test to keep LFS expectations independent of test order.
- **createGitServiceFixture**: The default raw mock reports the default-branch worktree as registered so initialize() reuses it; tests that exercise its creation install their own stand-in with mockInitializeGit.
- **mockInitializeGit**: mockInitializeGit is an args-keyed stand-in for the bare repository: the worktree list reports the default-branch worktree from the start when mainRegistered, otherwise only after worktree add runs (unless registersOnAdd is false), so reuse, creation and a creation that never registered can be told apart.
- **mockShowRef**: mockShowRef's localOnlyCommits answers the rev-list --count origin/<b>..<b> probe: 0 (default) means the local ref is only behind the remote, and 'unknown' makes the probe fail.

#### `src/services/__tests__/helpers/metadata-service-mock.ts`

- **worktreeMetadataServiceModuleMock**: The WorktreeMetadataService stand-in is shared by the module mock and the tests that assert on it, and it imports nothing but vitest so a vi.mock factory can load it before the mocked module exists.

#### `src/services/__tests__/hook-execution.service.test.ts`

- **livenessHook**: The liveness fixture hook records the node grandchild's own pid rather than the spawned shell's, so a test that finds that pid gone has shown the group kill travelled all the way down.
- **isAlive**: A killed orphan is reparented to pid 1 and stays a zombie when nothing reaps it (as in the test container), so kill(pid, 0) keeps succeeding. Where /proc exists the liveness probe reads the process state; elsewhere (macOS, where launchd reaps) ESRCH alone is the answer.
- **HookExecutionService.cleanup tests**: The SIGTERM-trap fixture deliberately echoes to stdout, because those writes are what turn into SIGPIPE if cleanup returns before the trap finishes.
- **HookExecutionService.cleanup tests**: The trap output is read without waitFor because the guarantee is that the trap is already done when cleanup resolves, the instant the caller exits; a missing file reads as no lines so an early return shows up as a value instead of an ENOENT.
- **HookExecutionService.cleanup tests**: The test puts a real, already-exited child back into activeProcesses to mimic a queued close event, so the ESRCH comes from the kernel rather than a test double.
- **HookExecutionService timeout tests**: Only setTimeout/clearTimeout are faked so the clock can pass the shipped 60s hook timeout while a real hook keeps running, which would expose a || in place of ?? arming the default for timeoutMs 0.

#### `src/services/__tests__/interactive-ui-launcher.real.test.ts`

- **editor launching against real processes**: The real-process launcher suite stubs only Ink, because the InteractiveUIService constructor renders and the shared test setup replaces global.console with a plain object lacking the Console constructor real Ink needs. child_process is deliberately left real.
- **editor launching against real processes**: The sibling launcher suite pins the argv built, which proves what was requested but not what ran. This suite uses real executable stand-in editors and asserts on the resulting processes, so child_process is never mocked.
- **isAlive**: An orphan reparented to pid 1 stays a zombie when nothing reaps it (as in the test container), so kill(pid, 0) keeps succeeding; the liveness probe reads the process state from /proc instead of relying on ESRCH.
- **writeEditor**: Each stand-in editor script writes its own pid as its first act, so afterEach can kill it even when a test throws before reading the pid; otherwise the process would be left untracked and pid 1 does not reap in the test container.
- **editor launching against real processes**: afterEach kills every recorded pid and the process groups they lead; the launcher spawns editors detached, so each child is its own group leader and anything it started is killed with it, leaving nothing reparented to pid 1.
- **InteractiveUILauncher.openEditorInWorktree tests**: The fake editor is named vim so terminal-editor detection fires, but it touches a marker file when run, acting as a tripwire: if the refusal ever regresses into a spawn the marker appears.

#### `src/services/__tests__/interactive-ui.concurrent-cycles.test.tsx`

- **overlapping sync cycles tests**: The overlapping-cycles suite fakes only node-cron; it drives real Ink both through the service's own render into a sink stream and through ink-testing-library for App assertions, so ink itself must stay real.
- **overlapping sync cycles tests**: calculateSyncDiskSpace resolves the formatted string the status bar renders; a mock returning an object makes React throw inside setDiskSpace, silently unmounting the App mid-test and voiding every later frame assertion, so the mock resolves a string.
- **overlapping sync cycles tests**: The shared test setup replaces global.console with a plain object that has no Console constructor, which Ink's console patching needs, so suites rendering real Ink reattach Console to it.
- **renderTestApp**: The overlapping-cycle tests assert on the frame the user actually sees rather than on the raw event stream, because the two disagreed and only the rendered frame exposed the bug.

#### `src/services/__tests__/interactive-ui.exit.test.tsx`

- **InteractiveUIService exit path tests**: Ink decides interactivity, and so whether it uses the alternate screen, from is-in-ci, which reads CI once at import time. The exit tests pin CI=0 in vi.hoisted before the import graph loads so terminal-ordering assertions mean the same locally and on CI, restoring it afterwards.
- **InteractiveUIService exit path tests**: The shared test setup replaces global.console with a plain object lacking a Console constructor, which Ink's patchConsole needs. Production renders with patchConsole on, so the tests restore the constructor rather than turning the option off and testing a configuration the CLI never uses.
- **InteractiveUIService exit path tests**: The stdoutIsTTY harness option is applied only when defined, so that false is honoured; a falsiness-based default would replace the interesting value.
- **InteractiveUIService quit tests**: In the forced-quit test both q presses reach handleQuit and both call exit, whereas in production the first never returns; the test therefore only requires that every exit call uses code 0, and the unfinished sync proves the shortcut ended the 30s wait.
- **InteractiveUIService cron lifetime tests**: A vi.fn mock attaches its own handler to promises it returns, making every rejection handled, so the unhandled-rejection test uses a plain function; a spy would pass even with no catch in the code.
- **isAlive**: A killed orphan is reparented to pid 1 and lingers as a zombie where nothing reaps it, so ESRCH alone never arrives; where /proc is available the liveness probe reads the process state instead.

#### `src/services/__tests__/interactive-ui.reload-logging.test.ts`

- **InteractiveUIService reload logging tests**: The sync gate in the reload fixture is consumed by the first sync that meets it, so a test can hold the reload's own sync open while a second overlapping cycle is never blocked by the gate.
- **InteractiveUIService reload logging tests**: The fake records whether a logger was present at construction time because the reload assigns the logger onto the same config object it hands the constructor; reading config.logger later cannot distinguish a logger present at construction from one assigned after initialize().
- **InteractiveUIService reload logging tests**: Console spies are cleared right before each reload because rendering the Ink tree in the constructor emits its own warnings (React's JSX transform notice) unrelated to the reload.
- **InteractiveUIService reload logging tests**: The call trace is reset before each reload because the UI constructor itself injects a logger into the service it was given, which is not part of any reload's sequence.
- **InteractiveUIService reload logging tests**: The cycle claim is taken before the cycle's first await, so starting the overlapping tick is enough before releasing the reload; with a parallelism limit of 1 the losing cycle would otherwise queue behind the reload instead of reporting anything.

#### `src/services/__tests__/interactive-ui.service.test.ts`

- **InteractiveUIService tests**: node-cron keeps every scheduled, not-yet-destroyed task in a registry, and what is there is what will fire; tests ask that registry which tasks a reload armed instead of reading the scheduler's private job list.
- **InteractiveUIService reload tests**: The pre-existing cron job double includes destroy() as well as stop() because teardown calls it; without it the call only reaches cancelCronJobs' catch, turning a missing method into an unread warning.
- **createAndPushBranch tests**: The getLocalBranchCommit double derives the oid from the branch name because the rollback's compare-and-swap must use the commit this attempt created; a constant oid would let a rollback reusing a stale oid pass.
- **InteractiveUILauncher terminal tests**: Terminal launch tests compare the whole argv rather than a prefix or substring, because a stray extra flag (e.g. after --args or a second -e) would change what the terminal is told to run and slip past a partial check.

#### `src/services/__tests__/interactive-ui.startup-sync-overlap.test.ts`

- **startup sync overlap tests**: The test lets the startup cycle reach its gated sync() by draining the event queues with setImmediate rather than waiting on a wall clock, since everything before sync() is synchronous or already resolved.

#### `src/services/__tests__/interactive-ui.status-fanout-and-disk.test.ts`

- **status fan-out and disk tests**: Only calculateDirectorySize is mocked; calculateSyncDiskSpace and formatBytes stay real so the header total under test is built by shipped code and the cache under test is the one it really calls.
- **status fan-out and disk tests**: Concurrency is counted inside the fake probe so the tests record what actually overlapped rather than what the production code was asked to build.

#### `src/services/__tests__/lfs-verification.service.test.ts`

- **mockWorktreeGit**: The LFS verification fake is keyed by argv because the attribute probe (git grep over HEAD's .gitattributes), the git-lfs probe (git lfs version) and git lfs ls-files all run on the same new-worktree client.
- **lfsWarnings**: The fixtures let the orphaned-directory cleanup emit its own warnings, so the LFS tests filter logger warnings to those mentioning LFS.
- **addWorktree LFS verification tests**: GIT_LFS_SKIP_SMUDGE is restored from an afterEach hook rather than a finally block, because a test body that never finishes (a timeout) would otherwise leave the variable set for the whole file.

#### `src/services/__tests__/logger.service.test.ts`

- **printedLines**: The shared test setup replaces console methods with vi.fn() stubs, so logger tests read printed lines back from those mock calls.

#### `src/services/__tests__/path-resolution.service.test.ts`

- **symlink boundary tests**: Environments without symlink privileges report EPERM, EACCES, UNKNOWN or ENOSYS when creating a symlink; the symlink-boundary tests treat those codes as 'unsupported' and skip rather than fail.
- **isPathInsideResolvedBaseDir parity tests**: The parity test also asserts that its case matrix produces both true and false verdicts, since agreement on an all-false run would pass against a check that never says yes.

#### `src/services/__tests__/repo-operation-lock.state-dir.test.ts`

- **RepoOperationLock state-dir tests**: The state-dir lock tests mock neither fs nor proper-lockfile: they run the real lock against a real directory, as the CLI meets it on CI containers or hardened hosts where the lock dir cannot be created, and as a daemon and shell-launched run meet on one workstation.
- **RepoOperationLock tests**: The shared test setup opts the whole vitest worker into the no-op repository lock via the unit-test shortcut, so lock tests delete that env var to exercise the real lock.
- **RepoOperationLock state-dir tests**: The simulated external holder locks with the same proper-lockfile options as RepoOperationLock (realpath false, 60s stale) so both sides contend for the same lockfile.

#### `src/services/__tests__/repo-operation-lock.test.ts`

- **isUnitTestShortcutEnabled**: The unit-test shortcut stores the vitest worker's own pid, and only a process with that pid honours it; child processes (the built CLI in e2e suites, hook commands) inherit the variable but always take real locks.

#### `src/services/__tests__/trash-migration.service.test.ts`

- **TrashMigrationService tests**: A control test adopts the identical .diverged/ fixture without tampering, so the rejection tests demonstrably concern the edited fields rather than a migration that never runs.

#### `src/services/__tests__/trash-reaper.immutable-payload.test.ts`

- **immutableAttributeWorks**: Unit tests model an undeletable file by replacing fs.rm; the immutable-payload test instead uses a real chattr +i file. That needs CAP_LINUX_IMMUTABLE and a filesystem supporting the attribute, so unprivileged runners, containers without the capability, tmpfs/overlay and macOS skip the test rather than fail it.
- **immutableAttributeWorks**: The immutable-attribute probe treats a successful chattr +i followed by a successful fs.rm as unsupported, because some filesystems accept the attribute without enforcing it.
- **TrashReaperService immutable payload test afterEach**: The immutable-payload test clears chattr +i on the payload file in afterEach before removing temp directories, because an immutable file also blocks deletion of the whole temp tree.

#### `src/services/__tests__/trash-reaper.service.test.ts`

- **trash-reaper.service.test fs/promises mock**: The reaper tests use a partial vi.mock of fs/promises that wraps rm and rename around the real implementations, because an ESM namespace export cannot be spied on. The real filesystem is used everywhere except the path a test declares undeletable.
- **trash-reaper.service.test afterEach**: The reaper test teardown resets the fs.rm and fs.rename mocks before cleaning up temp directories, because the cleanup deletes the temp trees with the same functions some tests replace.
- **makeEntry**: TrashService.trashDirectory always stamps the current time, so the test helper rewrites deletedAt and expiresAt in the on-disk manifest to simulate an entry trashed a given number of days ago.
- **TrashReaperService.purgeAllUnlocked test**: The selective-purge test creates two unselected entries so that the reported skippedNotSelected count cannot be confused with a hard-coded value of 1.
- **TrashReaperService re-check failure test**: A single rejected countCommitsNotOnAnyRemote stands in for every way it refuses to answer: a rev-list that exits non-zero, an unresolvable oid, and the method's own unparseable-count guard.

#### `src/services/__tests__/trash.service.branch-config.test.ts`

- **branchConfig**: git config --get-regexp exits 1 with empty stderr when nothing matches, which simple-git resolves to an empty string instead of rejecting; the test helper relies on that empty string as the 'no keys left' answer.
- **rawConfigText**: The branch-config tests read the raw config file because git config --get-regexp cannot see an empty [branch "x"] header; an implementation that unset the upstream keys individually would leave the header behind while every key-level assertion still passed.
- **branch-config test fixture**: The branch-config fixture pushes a second, genuinely different commit to a sideline branch so the compare-and-swap test has an oid different from the one every other branch was created from.
- **branch-config test**: The upstream config keys in the branch-config test are written by git itself via worktree add --track rather than hand-written, so the test exercises the real keys a CAS ref delete leaves behind.

#### `src/services/__tests__/trash.service.payload-size.test.ts`

- **trash.service.payload-size.test probe**: vitest hoists vi.mock ahead of every import, so the disk-space mock factory cannot close over ordinary module-scope bindings; shared probe state is created with vi.hoisted instead.
- **trash.service.payload-size.test probe**: Each recorded size scan also notes whether the source worktree was still on disk at that instant; a scan of a live worktree necessarily sees its source directory, so the field keeps the 'scanned the payload, not the worktree' assertions from passing vacuously.
- **TrashService.listEntriesWithSizes test**: The payload-size test asserts sourceOnDisk false because a scan that ran before the rename into trash would still have found the worktree in place.
- **TrashService.listEntriesWithSizes test**: listEntries returns only containers whose manifest passes every schema check, so an entry appearing in the result is itself the assertion that its manifest is valid, not merely present.
- **TrashService.listEntriesWithSizes concurrency test**: The concurrency test holds every scan open until the limiter stops admitting more; a serial implementation parks on the first scan and reports a peak of 1.
- **TrashService.listEntriesWithSizes concurrency test**: The concurrency test lets the limiter admit everything it will while nothing may finish, spinning setImmediate turns until the event loop is quiet; the number of parked scans at that point is the cap.

#### `src/services/__tests__/trash.service.restore-rename.test.ts`

- **makeDirtyWorktree**: The restore fixture contains an uncommitted edit to a tracked file and an untracked node_modules directory, standing in for the build output that makes a payload expensive to copy and worth moving instead.
- **occupyAdminName**: The restore test first takes the worktree admin directory name feature with a decoy worktree, forcing restore's worktree add onto feature1 so its .git link differs from the stale link the payload carries. Otherwise the two links are byte-identical and assertions about which link survived would pass whether or not restore rewrote it.

#### `src/services/__tests__/trash.service.test.ts`

- **trash.service.test fs/promises mock**: The trash service tests partially mock fs/promises because ESM namespace exports cannot be spied on; rm, rename, cp and writeFile become pass-through spies over the real implementations. rename and cp are spied so tests can assert that restore moves the payload rather than copying it.
- **createFreshWorktreeDir**: git worktree add --no-checkout leaves the directory with exactly one entry, the .git link (measured on git 2.43). Restore reads that link back to re-point the moved payload, so the default git stub creates both the directory and the link rather than the directory alone.
- **failRenameWhen**: failRenameWhen fails only the renames a test names and passes everything else to the real fs.rename, because manifest writes and the trash move also use rename and a blanket failure would break the fixture. It models the EXDEV a bind mount or symlinked worktreeDir causes between trash root and worktree, and a failing rollback rename.
- **trash.service.test afterEach**: The trash service test teardown restores the real fs.rm, rename and writeFile before deleting temp directories, because the cleanup uses the same functions some tests replace.
- **TrashService.readManifest pin ref test**: The padded branch-ref case is sized so the root-hash slice lands on real hex even without the prefix check, ensuring the prefix check alone rejects it.
- **TrashService.readManifest branch test**: A numeric branch value would make isGitCreatableBranchName throw, which readManifest's catch turns into the same null result, so the non-string case only pins the typeof guard indirectly; a separate numeric case exercises a value the predicate would otherwise accept.
- **TrashService.restore control test**: A control test uses the identical fixture with a real branch name and confirms it lists and reaches createBranchAt, so the rejection tests are about the branch value and not about a restore that never runs in the suite.
- **TrashService.readManifest headOid test**: The numeric headOid 123456 passes the hex regex once stringified, so only the typeof guard rejects it; the case exists so a mutant dropping that guard fails the suite.
- **TrashService.readManifest optional-field test**: The optional-field tolerance test first asserts the key exists in the fresh manifest, because deleting an absent key would prove nothing.
- **TrashService relocation test**: The relocation test moves worktreeDir back in a finally block, because a failed assertion would otherwise leave the fixture relocated and break the rest of the suite.
- **TrashService restore link-fail test**: Real git worktree remove --force deletes the registered directory but the stub only records the call, so the test removes the directory itself before retrying, since restore refuses an existing destination.
- **TrashService restore symlink test**: The symlink restore tests cover both the rename and cross-device copy paths (the latter uses copyTreePreservingSymlinks), and assert nothing until the trash container is gone, because a link rewritten to a path under .trash would still resolve while the container exists.

#### `src/services/__tests__/worktree-creation.service.test.ts`

- **mockFallbackAdd**: The no-tracking fallback's plain add sets no upstream and looks up origin/<branch> again afterwards. The fallback test helper makes the first lookup succeed (otherwise the tracking add is never tried) and controls the second via remoteAfterAdd.

#### `src/services/__tests__/worktree-creation.sparse-checkout.test.ts`

- **LFS-verification client test**: applySparseAndCheckout also creates a worktree client through getCachedGit, which already has the allowances, so the test hands out a fresh client per simpleGit() call and pairs each .env() with the options its own client was constructed with.

#### `src/services/__tests__/worktree-creation.stale-branch-copies.test.ts`

- **divergedHandling**: The stale-branch-copy tests filter sync actions for diverged handling (preserved-diverged, reset_* updates, diverged_recovery_failed) because the regression is the update phase treating a newly created worktree as behind or diverged.
- **stale-branch-copies local-only test**: The local-only commit is built with commit-tree on origin/feature's tree, so only the commit itself is local; that models both a never-pushed commit from a removed worktree and a copy whose history was rebased away on the remote.

#### `src/services/__tests__/worktree-metadata.service.test.ts`

- **worktree-metadata.service.test beforeEach**: saveMetadata writes atomically (open a .tmp file, write and fsync through the handle, then rename), so the metadata tests mock fs.open with a file handle exposing writeFile, sync and close, plus fs.rename.

#### `src/services/__tests__/worktree-mode-sync-runner.detached-create.test.ts`

- **detached-create test fixture**: The detached-create fixture keeps the worktree directory on disk with a .git link into the bare repository: only the registration is detached, which keeps it out of the inventory, and the link tells worktree naming the directory is the managed repository's checkout rather than a stranger's.
- **detached-create test git stub**: getWorktrees filters out detached registrations, so the stub returns only main and the planner sees feature-x as a branch without a worktree and plans a create for it.

#### `src/services/__tests__/worktree-mode-sync-runner.lfs.test.ts`

- **LFS runner test fixture**: The LFS runner tests create the default branch's worktree directory up front so the planner leaves it alone and every create action is a genuinely new branch.
- **LFS concurrent-failure test**: The concurrent LFS test delays each first attempt so every branch starts before any fails, ensuring all observe the skip as disabled and all reach the fallback.

#### `src/services/__tests__/worktree-mode-sync-runner.path-partition.test.ts`

- **path-partition test spies**: The partition test tracks the peak number of outstanding async realpath calls, because that is what the concurrency bound controls and, unlike elapsed time, it does not vary with machine load or coverage instrumentation.
- **path-partition fs mocks**: The fs spies in the partition test count calls and then delegate to the real functions, because containment verdicts only mean something against a real filesystem.
- **WORKTREE_COUNT**: The partition test uses 400 worktrees so 'once per worktree' and 'once per partition' call counts cannot be confused, and so the old synchronous version's event-loop blocking was measurable.
- **path-partition git stub**: The stubbed main worktree path does not exist on disk, so the anchor check makes no realpath call and the realpath counts reflect the partition alone.
- **path-partition git stub**: Only the default branch is on the remote in the partition test, so registered worktrees are never planned branches and dropStaleRegistrations, the only other awaiting step between the listing and the 'Found N' log line, has nothing to probe.
- **path-partition git stub**: Every registered branch is a prune candidate in the partition test, so getFullWorktreeStatus refuses removal to keep that phase to one mocked call per worktree.
- **path-partition symlink test**: Environments without symlink privileges fail symlink creation with EPERM, EACCES, UNKNOWN or ENOSYS, so the symlink-escape test returns early on those codes instead of failing.
- **path-partition event-loop test**: Between the worktree listing and the 'Found N managed' line only the partition runs (dropStaleRegistrations short-circuits with no registered branch on the remote). A synchronous partition blocked the loop for a single 5-8 ms stall at 400 worktrees, so the test counts setImmediate probe ticks in that window instead of using a wall-clock threshold a loaded CI machine could trip.

#### `src/services/__tests__/worktree-naming.test.ts`

- **pushBranch**: The naming test packs refs before pushing so branch names differing only in case (Docs/docs, main/MAIN) can coexist on a case-insensitive filesystem as they do in a real clone; as loose ref files the second would collide with the first.

#### `src/services/__tests__/worktree-status.ambiguous-ref.test.ts`

- **ambiguous-ref test**: The ambiguous-ref test first asserts that the bare name counts 0 while refs/heads/<name> counts 1, so the fixture keeps demonstrating the tag-shadowing behaviour it guards against.
- **ambiguous-ref test**: The fully-pushed case pushes with an explicit refs/heads refspec because git push origin <name> is itself ambiguous when a same-named tag exists.

#### `src/services/__tests__/worktree-status.process-budget.test.ts`

- **tracked**: The process-budget test's tracked helper resolves on a later event-loop turn, as a real spawn does, so overlapping commands are actually observed in flight.

#### `src/services/__tests__/worktree-status.service.test.ts`

- **worktree-status.service.test header**: The status tests keep the parsed git status -b header (branch, upstream, ahead/behind) separately and merge it into each test's status mock, because the status snapshot takes the checked-out branch from that header.
- **worktree-status.service.test mockForEachRef**: The repository-wide for-each-ref scan is mocked separately from raw so assertions about per-worktree git subcommands see only per-worktree commands.

#### `src/services/__tests__/worktree-sync.clone-phase-timing.test.ts`

- **clone-phase-timing clock**: The clone phase-timing test uses a clock that mocked git commands advance by hand, since PhaseTimer and Timer read Date.now(), so each phase's duration is exactly what the test specifies.
- **tableRow**: The rendered timing table is cli-table3 box drawing, so the test looks up a phase by the line its name appears on and reads that line's duration cell.
- **installGitMock**: Each probe of a clone-mode tick spends a distinct, recognizable slice of the mocked clock, so a row reporting another phase's cost shows up in the assertion rather than looking plausible.
- **makeService**: The clone phase-timing test marks the clone sync service initialized up front because the tick under test is an ordinary one, not the initial clone.
- **clone-phase-timing beforeEach**: The clone timing suite models a 38-second git status over a large checkout, the slow working-tree scan whose cost was previously hidden inside the total.
- **clone-phase-timing no-status test**: The no-status-row test also asserts the phases that did run, so the missing row is shown to be a skipped phase rather than a table that stopped early.
- **clone-phase-timing naming test**: Phase names are asserted through exported constants everywhere else, which cannot catch a value edited out of the shared 'Phase N: Name' convention both modes print, so one test asserts a literal.

#### `src/services/__tests__/worktree-sync.repo-mutex.test.ts`

- **repo-mutex test afterEach**: The repo-mutex tests restore all mocks after each test because spies installed on service prototypes would otherwise outlive the test that created them.
- **trash lock options test**: The trash lock test uses an id no listing can produce, because the point is which options reached acquire(); the operation body may then reject for any reason.

#### `src/services/__tests__/worktree-sync.service.test.ts`

- **worktree-sync.service.test git mock**: getAheadBehindCounts is the one probe the update phase runs per worktree and the one diverged handling re-verifies with before moving anything; its default mock reports nothing on either side so worktrees are up to date unless a test says otherwise.
- **worktree-sync.service.test handleWrites**: Audit records and trash manifests are written durably through fs.open plus handle writeFile/appendFile and sync, not fs.writeFile/appendFile, so the sync service tests record handle writes to assert on what was written and where.
- **worktree-sync.service.test beforeEach**: fs.readdir resolves to an array or throws, never undefined, so the default mock returns an empty array; suites indifferent to directory contents still reach it through the trash listing, where undefined read as a hard failure.
- **worktree-sync.service.test beforeEach**: Worktree naming probes <worktreeDir>/<plain name> with lstat before assigning a plain directory, so the default lstat mock reports ENOENT for those paths unless a test places something there.
- **worktree-sync.service.test mockConfig**: The sync service suites disable trash because they assert the direct-delete mechanism; the trash pipeline is covered by its own trash.service, trash-reaper and trash-migration suites.
- **mockBusyWorktrees**: The busy-worktree probe reads the bare repo's entries, then worktrees/, then each registration's admin directory via fs.readdir, while other tests need the .diverged listing; both are routed through one readdir implementation.
- **created worktree tip verification tests**: The tip-verification tests list the anchor worktree explicitly, because an empty worktree listing reads as a detached default-branch anchor.
- **locked worktrees afterEach**: vi.clearAllMocks() drops recorded calls but not implementations, so the locked-worktree tests reset getWorktreeLock's resolved value explicitly after each test.
- **update phase test**: With no remote branch tips to compare against, the update phase cannot settle any worktree from its listed HEAD, so every clean worktree reaches the ahead/behind probe in the test.
- **default-branch heal afterEach**: vi.clearAllMocks() keeps implementations and the git service mock instance is shared across every suite in the file, so the anchor-heal tests reset ensureAnchorWorktree explicitly afterwards.
- **trash maintenance wiring tests**: The trash maintenance call site is gated off by the worker-wide unit-test shortcut env var set in setup.ts, so these tests unset it to exercise the wiring, leave NODE_ENV as test (it must not matter), and stub the cross-process lock so no real lock is taken.
- **diverged-replace test readdir mock**: The trash root is read with withFileTypes, so the readdir mock returns an empty list for it rather than names, which the listing would receive where it expects Dirents.
- **diverged-replace test setup**: The diverged-replace test re-stubs the git calls that flow depends on, because the shared mock instance may carry rejections configured by earlier suites.
- **diverged EXDEV fallback test**: The cross-device diverged fallback test runs on a real filesystem: production options drive a real fs.cp over a tree with a relative symlink and production's fs.rm then deletes the source, which is what would turn a link rewritten to an absolute path into a dangling one. Assertions come after that delete because such a link still resolves until then.
- **diverged EXDEV fallback test**: vi.clearAllMocks() keeps implementations, so the EXDEV test resets the fs.cp and fs.rm mocks that reach the real filesystem in onTestFinished, preventing them from leaking into the rest of the file.
- **git maintenance wiring tests**: The git maintenance call site is gated off by the worker-wide unit-test shortcut env var set in setup.ts, so these tests unset it to exercise the wiring, leave NODE_ENV as test, and stub the cross-process lock so no real lock is taken.

#### `src/services/__tests__/worktree-sync.trash-size-off-lock.test.ts`

- **trash-size-off-lock test probe**: The trash-size lock tests record, from inside each size scan, whether a fail-fast repository operation could start at that moment. Recording it inside the scan makes the test impossible to pass vacuously, because a scan under the lock can never record true.
- **trash-size-off-lock test RepoOperationLock mock**: The RepoOperationLock mock models only what the trash-size tests need from the cross-process file lock: a second acquire while held is refused and release is observable.

#### `src/services/__tests__/worktree-update.test.ts`

- **worktree-update test setup**: The worktree update tests stub fs.readdir to resolve to an empty array because the real readdir never resolves to undefined, and these suites reach it through the trash listing even when they only test update behaviour.
- **worktree-update test setup**: The worktree update test mock returns no remote branch tips by default so that no worktree takes the nothing-changed fast path and every worktree reaches the per-worktree probes.
- **worktree-update test fast-path suite**: fs/promises is module-mocked and vi.clearAllMocks keeps mock implementations, so the fast-path suite resets the fs.access stub after each test; otherwise an access stub set in one test would leak into every later test in the file.
- **worktree-update default branch retention test**: The readdir mock returns plain directory names for the worktree directory but an empty list for the trash root, because the trash root is read with withFileTypes and must not be handed plain names.
- **worktree-update default branch gone suite**: The default-branch-gone tests turn trash off so a prune ends in a plain removeWorktree, and they provide a mocked file handle because the removal audit record is written before the removal.

#### `src/types/__tests__/public-config-types.test.ts`

- **public-config-types.test**: Every key of the internal resolved Config must be classified into exactly one bucket; an unclassified new field makes UnclassifiedConfigKeys non-never and fails `pnpm typecheck`, forcing a deliberate decision about whether it belongs on the hand-written public config surface.
- **public-config-types.test**: Common config fields must exist on the public repository type with value types matching internal Config, optionality stripped. Both sides are normalized into concrete object shapes before comparison because a per-key Equal stays deferred while the key is generic; a missing public field becomes an index error, so it fails closed.
- **publicTypeModules**: The public-type test walks every source module the public entry imports transitively, because tsc emits a .d.ts for each one and that set is what dist ships as declarations.

#### `src/utils/__tests__/config-generator.test.ts`

- **config-generator.test**: Generated-config assertions inspect only the config object before `export default config;`, because a commented cheatsheet follows it and would match field names.
- **config-generator.test**: Generated configs are tested by loading them through the real ConfigLoaderService rather than asserting on text, because a config can look right yet fail to load (e.g. `export default` in a .cjs file or in a .js file under a commonjs package is a SyntaxError on Node 22 and 24).
- **config-generator.test**: Module-system tests create their package directory outside the repository, because the repository's own package.json declares `type: module` and would mask every case.
- **repositoryCountUnderRealNode**: Generated config files are loaded in a real node child process the way ConfigLoaderService does (require for .cjs, import() otherwise), because Vitest resolves import() through its own pipeline and would load a .js file in a commonjs package that Node rejects.

#### `src/utils/__tests__/disk-space.test.ts`

- **disk-space.test**: The disk-space tests mock child_process with the real execFile as default, overridden only when a test scripts du's answers, so one file covers both output parsing and a real du run.

#### `src/utils/__tests__/disk-usage-cache.test.ts`

- **gatedSizes**: The gatedSizes helper releases each walk separately with its own size so a test can tell a stale walk's result from the walk that overtook it.
- **DiskUsageCache**: The disk-usage cache expiry test advances by a literal minute rather than DISK_USAGE_CACHE_TTL_MS, because a test using the constant cannot tell a minute from forever; the promised behaviour is caching for up to a minute.

#### `src/utils/__tests__/git-busy-probe.test.ts`

- **git-busy-probe tests**: The vanished-registration race is simulated with a dangling symlink because it is listed by readdir and then fails ENOENT on read, exactly the shape git worktree prune leaves mid-flight; a plain absent entry is never listed and proves nothing.

#### `src/utils/__tests__/git-client.test.ts`

- **git-client tests**: The createGitClient tests run real git with no mocks, because they must prove the forwarded environment is accepted by both git and simple-git and that git really behaves non-interactively.
- **git-client tests**: git runs GIT_SSH_COMMAND through the shell with the environment it was given, so a command that dumps env to a file reveals exactly what git's children see; the locale tests use this to observe the child environment.
- **git-client tests**: The HTTPS auth test removes every credential source (fresh HOME, no system config, no askpass, no inherited GIT_TERMINAL_PROMPT) so that only the client's own prompt-disabling can explain the fast failure.
- **git-client tests**: The auth test's block timeout is only a backstop: without prompt disabling and with a terminal attached, git would wait on its prompt until that timeout fired, so the test asserts failure well within it.

#### `src/utils/__tests__/git-url.test.ts`

- **git-url tests ACCEPTED**: The accepted-URL table rows are [url, extracted name, syntax kind], and every branch of the URL grammar is reached by at least one row.

#### `src/utils/__tests__/interactive.test.ts`

- **promptForInitConfig tests**: The init wizard tests use a config directory that none of the mocked answers point at, so the equal-to-config-directory guard stays quiet unless a test deliberately targets it.
- **promptForInitConfig tests**: Relative wizard answers resolve against the cwd, so the relative-path guard test points the config directory at the cwd to exercise it.

#### `src/utils/__tests__/mcp-registration.test.ts`

- **mcp-registration tests**: promisify(execFile) calls execFile with a trailing callback, so the mock invokes that callback directly to simulate ENOENT, non-zero exits or success per command.

#### `src/utils/__tests__/unknown-config-keys.test.ts`

- **unknown-config-keys tests**: The known-key inventory is read off the config schema, so these tests pin that the schema declares exactly the keys of the handwritten types. Each expected map is typed Record<keyof X, true>, which the compiler rejects if a key is missing or extra, making keyof X a runtime value; the type-level half lives in config-schema.test.ts, so adding a Config field without updating the schema fails both typecheck and these tests.

## Consequences

Changing code covered by an entry here means updating the entry in the same pull request. An entry that no longer holds is deleted, or superseded by a new numbered ADR when the reversal is itself a decision worth keeping.
