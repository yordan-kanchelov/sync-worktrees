# ADR-0005: Concurrency and locking

- **Status:** Accepted
- **Date:** 2026-11-20
- **Source:** 78 code comments as of `5f17242`, moved here by [ADR-0001](./0001-record-decisions-in-adrs-not-comments.md)

## Context

Syncs run on a cron schedule, from the TUI, from the CLI and from the MCP server, possibly in several processes at once against the same repositories. A cross-process lock file and in-process mutexes serialise mutating work, and parallelism limits bound how many git processes run at once.

## Decisions

Grouped by the file that implements them, source before tests. Each entry names the symbol it governs.

### `src/cli/trash-command.ts`

- **dropAllKeepRefs**: The keep-ref names are read before the confirmation prompt and passed to the service as the exact set to delete, because a sync running alongside can mint keep refs for entries it just reaped, and those were never shown to the person confirming.

### `src/components/App.tsx`

- **App**: After branch creation, context.repoIndex indexes the repository list of the render's reload generation. Each follow-up step re-resolves the index, so the flow stops at the first step after a reload, when the same index would name a different repository.

### `src/constants.ts`

- **DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS**: MAX_STATUS_CHECKS is also the size of WorktreeStatusService's shared process budget, through which every status probe of a repository runs, so it bounds concurrent git processes rather than worktrees.
- **LOCK_WAIT_MS**: sync-worktrees trash restore|purge --wait waits at most two minutes for a repository lock another process holds: long enough to outlast an ordinary sync tick, short enough that a scripted invocation that will never get the lock still terminates and reports why.
- **ENV_CONSTANTS.LOCK_DIR**: SYNC_WORKTREES_LOCK_DIR moves the repository lock files out of the default .sync-worktrees-locks directory beside the worktreeDir; it must be set identically for every process sharing a worktreeDir or they will not see each other's locks (see src/utils/lock-path.ts).
- **PATH_CONSTANTS.LOCK_DIR_NAME**: The cross-process lock file for a worktreeDir lives in a .sync-worktrees-locks directory next to the worktreeDir, never inside it.

### `src/index.ts`

- **runMultipleRepositories**: A repository that did not start because of lock contention counts as skipped, since whoever holds the lock will sync it; an unavailable lock counts as a failure, because nothing synced the repository and nothing will.

### `src/mcp/handlers.ts`

- **notStartedError**: A repository operation that did not start because of contention (in_progress or locked) maps to the retryable SYNC_IN_PROGRESS error, while an unavailable lock is a distinct, non-retryable failure that names its cause.

### `src/mcp/utils.ts`

- **RepoLockUnavailableError**: LOCK_UNAVAILABLE means the cross-process repository lock could not be prepared or taken (ENOTDIR, EACCES, EROFS, ENOSPC and similar). Unlike SYNC_IN_PROGRESS nothing else is working on the repository; the operation simply did not run and retrying will not help until the state directory is fixed.

### `src/services/branch-ref.service.ts`

- **BranchRefService.deleteLocalBranchIfAt**: The removal pipeline deletes a branch ref with update-ref -d and an expected oid, so a commit that races the removal keeps its ref instead of being orphaned by an unconditional branch -D.
- **BranchRefService.deleteLocalBranchIfAt**: The branch config section is removed only after the compare-and-swap ref delete succeeds; a CAS rejected because the ref moved leaves the still-live branch with its upstream.

### `src/services/git.service.ts`

- **GitService.ensureMainWorktree**: A concurrent creator can land between addWorktree's existence probe and git's own check, making git report the path as existing; that is accepted only if the path is now a registered worktree, and an unregistered directory remains an error.

### `src/services/InteractiveUIService.tsx`

- **InteractiveUIService.handleReload**: The reload's sync claims its repositories like any cycle, because the new cron schedules are already armed and a tick landing during the await would otherwise call clearRecordedSkips for repositories the reload is syncing.

### `src/services/repo-operation-lock.ts`

- **RepoLockAcquireResult**: Lock acquisition distinguishes locked (proper-lockfile ELOCKED, another process holds it), which is a clean skip, from lock_unavailable (the lock directory or file could not be prepared or locked), which must surface as a failure with its cause and never as another process holding the lock.
- **RepoOperationLockOptions.waitMs**: waitMs defaults to 0, keeping the fail-fast behaviour periodic callers rely on, since a cron tick that cannot get the lock is a clean skip. A non-zero value is for explicit one-shot user commands such as trash restore or purge; it is an absolute deadline shared by both locks a worktree-mode repository takes, so a non-interactive run always terminates.
- **LOCK_RETRY_INTERVAL_MS**: Lock retries use a fixed one-second interval rather than proper-lockfile's exponential default, so the wait budget is wall-clock time a caller can quote to the user.
- **retriesUntil**: Callers without a wait budget pass retries: 0, proper-lockfile's literal default, so the no-wait path stays a single failed attempt rather than a retry loop with a zero count.
- **RepoOperationLock.acquire**: The lock wait deadline is resolved once as an absolute time because worktree mode takes two locks in sequence and a per-lock budget would double the worst case.
- **RepoOperationLock.acquire**: A worktree-mode operation also holds a lock keyed by worktreeDir, because destructive operations happen under worktreeDir and two config files can point different bare repositories at the same worktreeDir while each holds its own bare-repo lock.
- **RepoOperationLock lock options**: proper-lockfile's default onCompromised throws from its refresh timer, uncatchable and fatal to the multi-repo process; losing the lock only risks a concurrent start, the lesser harm, so the handler warns and lets the in-flight operation finish.
- **RepoOperationLock.unavailable**: A lock the process cannot take (read-only filesystem, ENOSPC, EACCES, a lock directory that is a file) must not crash the multi-repo run but is not contention either, so the path and errno are named and a typed lock_unavailable reason is returned so the caller reports a failure rather than a skip.

### `src/services/repository-operations.ts`

- **RepositoryOperations.fetchForRepo**: Inside a queued repository operation, an uninitialized service is initialized via initializeUnlocked, because initialize re-enters the repository mutex and would self-deadlock.
- **RepositoryOperations.describeNotStarted**: Interactive operations queue behind in-flight work, so a not-started result means the cross-process lock: contention is reported as retryable, while an unavailable lock names its cause.
- **RepositoryOperations.createAndPushBranch**: Branch creation and push run as a queued repository operation so they cannot race a sync on git's index and refs; worktree creation is a separate queued operation.

### `src/services/sync-cycle-scheduler.ts`

- **SyncCycleScheduler.syncingServices**: SyncCycleScheduler tracks which repositories are claimed and how many cycles are running at scheduler level, because both are properties of the set of cycles in flight rather than of whichever cycle finishes first.
- **SyncCycleScheduler.runSyncCycle**: Sync cycles overlap by design (startup sync plus cron, slow ticks, schedule collisions, manual `s`). A cycle claims only repositories no other cycle holds and reports the rest as `in_progress` skips, because a losing cycle would otherwise clear the in-flight cycle's recorded clone-mode skips and a second cron group would starve. Status is tracked across the set of cycles rather than per cycle so one finishing cycle cannot blank another's progress rows or re-enable the `s`/`x`/`r` guards, and no cycle starts once quitting has begun so the shutdown wait does not have to outlast it.
- **SyncCycleScheduler.runSyncServices**: A sync not started because the repository lock was unavailable is reported as a failure rather than a skip, since nothing synced the repository and no other process will.

### `src/services/worktree-mode-sync-runner.ts`

- **WorktreeModeSyncRunner.createNewWorktrees**: Worktree creation defaults to concurrency 1 because concurrent `git worktree add` operations can race on git's worktree lock; when concurrent creators hit 'already registered', addWorktree checks whether the worktree actually exists.
- **WorktreeModeSyncRunner.assessPrune**: Prune runs read-only status checks in parallel first, then removals at lower concurrency. The check limit bounds checks in flight while the status service bounds the git processes they spawn with a budget of the same size, so hundreds of candidates still peak at maxStatusChecks git processes.

### `src/services/worktree-sync.service.ts`

- **describeNotStarted**: When an exclusive repository operation does not start, only lock_unavailable names a real cause; in_progress and locked are contention with another operation or process.
- **WorktreeSyncService.repoMutex**: Each repository has an in-process FIFO mutex serializing all bare-repo-mutating operations (sync, init, interactive create): wait:true callers queue behind an in-flight operation and wait:false callers fail fast. The cross-process file lock (RepoOperationLock) is acquired inside the mutex body for multi-process safety.
- **WorktreeSyncService.restoreFromTrash**: Trash restore holds the repository lock because the reaper, prune and gc mutate the same entries and refs at the end of a sync, and it queues (wait:true) since restores are explicit user actions. lockWaitMs extends that waiting to the cross-process lock so a restore during a daemon's sync can wait a bounded time instead of failing; the default remains fail-fast.
- **WorktreeSyncService.runMaintenanceIfDueUnlocked**: Scheduled gc runs inside the already-held repository lock and must not re-enter runExclusiveRepoOperation, which would deadlock or skip. It is skipped under the unit-test shortcut so unit suites do not run real git; GitMaintenanceService has its own tests.
- **WorktreeSyncService.runExclusiveRepoOperation**: Fail-fast callers (sync, init, MCP) bail when any repository operation is active or queued, while wait:true callers queue on the mutex. The count check and the mutex enqueue run with no await between them, so on the single JS thread a second fail-fast caller always sees the first.
- **WorktreeSyncService.runExclusiveRepoOperation**: When the repository lock cannot be prepared or taken at all, the operation is reported as lock_unavailable, a failure with a named cause, rather than a skip blaming another process.
- **WorktreeSyncService.sync**: Recorded clone-mode skips are cleared once the sync actually starts inside the lock rather than by callers, because a losing concurrent caller clearing the shared accumulator would truncate the winner's skips.

### `src/types/index.ts`

- **RepoLockUnavailable**: RepoLockUnavailable means the cross-process repository lock could not be taken for a reason other than contention (lock directory or file could not be prepared or locked, e.g. ENOTDIR, EACCES, EROFS, ENOSPC); nothing else holds it and the operation did not run.
- **RepoOperationNotStarted**: A repository operation that did not start because of in_progress or locked is contention and reads as a skip, while lock_unavailable is an infrastructure failure of the current run.

### `src/utils/git-busy-probe.ts`

- **probeInFlightGitOperations**: The busy probe is a point-in-time check, not mutual exclusion: someone can start git commit right after it returns clean. It reliably catches long-lived states such as abandoned merges or rebases and held index.lock files, and is a reason to refuse, never evidence that proceeding is safe.

### `src/utils/lock-path.ts`

- **canonicalizeForLockKey**: Two spellings of one directory (symlinked HOME, macOS /tmp) must hash to the same lock file or both processes proceed. Canonicalization walks up to the nearest existing ancestor, since several components may not exist on a first run, so the key stays stable between the first run that creates the directory and later runs.
- **getWorktreeDirLockTarget**: The worktree lock is keyed only by the canonical worktreeDir so different configs or programmatic runs on the same checkout contend; worktree mode holds it in addition to the bare-repo lock because two configs can point different bare repos at one worktreeDir. Its location must not depend on HOME or XDG_STATE_HOME, which daemons, shells and sudo disagree on, so it sits in <parent>/.sync-worktrees-locks/ next to the worktreeDir, never inside it (pruned by sync) or under ~/.cache (cleaners). SYNC_WORKTREES_LOCK_DIR is the one escape hatch and must be identical for all sharing processes.

### `src/utils/repo-lock-format.ts`

- **formatRepoLockUnavailable**: CLI, TUI and MCP all render an unavailable repository lock through one formatter so the lock path and errno that explain the failure always reach the user.

### Tests

Why the tests that pin these decisions are built the way they are.

#### `src/__tests__/e2e/clone-mode.e2e.test.ts`

- **lock directory placement**: Repo lock files live in .sync-worktrees-locks next to (never inside) each worktreeDir, i.e. in the worktreeDir's parent directory.

#### `src/__tests__/e2e/concurrent-runs.e2e.test.ts`

- **getWorktreeDirLockTarget**: Worktree mode takes the bare-repo lock first and returns early when it cannot, so concurrent runs contend on `<bareRepoDir>.lock`, not on the worktreeDir-keyed lock. The worktreeDir lock is asserted only for its derivation: it lives in `<parent>/.sync-worktrees-locks` and its filename is keyed on the worktreeDir alone, with no pid or per-process component.

#### `src/__tests__/e2e/lock-unavailable.e2e.test.ts`

- **RepoOperationLock acquire failure handling**: When the lock directory cannot be created (SYNC_WORKTREES_LOCK_DIR pointing at a file, a read-only volume) the run fails loudly with exit 1, because nothing synced and a green exit blaming 'another process' would let a pipeline pass having done nothing. Real contention remains a skip with exit 0, and must be detected regardless of differing HOME and XDG_STATE_HOME between a daemon and a shell-launched run.
- **getWorktreeDirLockTarget**: The repo lock lives next to the canonical worktreeDir regardless of the process environment, so a test can derive the exact path a child CLI will use.

#### `src/__tests__/e2e/node-env-independence.e2e.test.ts`

- **getWorktreeDirLockTarget**: The repo lock lives next to the canonical worktreeDir regardless of the child's environment, so a test can derive the lock file the child used.

#### `src/__tests__/index.run-once.test.ts`

- **runMultipleRepositories lock_unavailable handling**: A repository whose lock could not be taken because the lock location is unusable (ENOTDIR, unwritable) is counted as failed and named in the summary with a failing exit status, because nothing synced it and a green exit would let CI pass without any clone or fetch; real contention remains a skip.

#### `src/mcp/__tests__/handlers.test.ts`

- **WorktreeSyncService.sync**: WorktreeSyncService clears recorded skips at the start of sync(), inside the repository lock; the sync handler does not clear them itself, so stale skips from a previous run are replaced by the new run's.
- **handleSync**: A repository lock that cannot be taken (lock_unavailable) is not contention and not retryable: the sync never ran, so the error carries the cause instead of claiming a sync is already in progress.

#### `src/mcp/__tests__/read-only-index.test.ts`

- **read-only MCP tools**: MCP tools marked readOnlyHint must not refresh (rewrite) a worktree's git index, because in a parallel-agents setup that takes index.lock while another agent may be committing.

#### `src/services/__tests__/config-loader.example-config.test.ts`

- **getWorktreeDirLockTarget**: For a clone-mode repository the lock directory is a sibling of the checkout, under the parent of worktreeDir, and never inside the checkout itself.

#### `src/services/__tests__/git-maintenance.service.test.ts`

- **GitMaintenanceService.runNowUnlocked**: The bare repository's object store is shared by every checkout, and `git gc --prune=now` deletes objects a concurrent `git commit` has written but not yet referenced. An explicit maintenance run therefore prunes with FORCE_CLEAN_PRUNE_EXPIRE (one hour ago) instead of now, unless the aggressive config flag, which documents the hazard, asks for `now`.

#### `src/services/__tests__/interactive-ui.concurrent-cycles.test.tsx`

- **WorktreeSyncService.runExclusiveRepoOperation**: runExclusiveRepoOperation refuses a fail-fast caller while the per-repository mutex is busy, so a second sync of the same repository resolves { started: false, reason: 'in_progress' } without touching it; the test fake reproduces that guard.
- **sync-cycle-scheduler**: The scheduler's in-process claim keeps two cycles off one repository, but it cannot prevent the fail-fast that happens when the repository mutex is held by another process or by an interactive operation in this one; that case still surfaces as in_progress.

#### `src/services/__tests__/interactive-ui.reload-logging.test.ts`

- **InteractiveUIService reload**: A cycle must never reach clearRecordedSkips() for a repository another cycle is syncing, and that includes the reload, which always syncs every repository. Because the reload arms the new cron jobs before running its sync, a tick in that window is routine, so the reload's sync goes through the same claim as other cycles instead of calling runSyncServices directly.

#### `src/services/__tests__/interactive-ui.service.test.ts`

- **SyncCycleScheduler skip reporting**: A repository whose lock could not be taken because the state directory is unwritable is not contention; it is logged at error level with the path and errno, never as 'Sync skipped'.
- **InteractiveUIOperations.createAndPushBranch**: Branch creation and push run through the queued repository lock so they wait behind any in-flight sync instead of racing it on git's refs.
- **InteractiveUIOperations.createWorktreeForBranch**: The new worktree's directory is named by GitService.resolveNewWorktreePath inside the queued repository operation, so the name is chosen while holding the lock.
- **RepositoryOperations fetch**: Inside a queued repository operation the code must call initializeUnlocked, because initialize() re-acquires the repository mutex and would self-deadlock.

#### `src/services/__tests__/interactive-ui.startup-sync-overlap.test.ts`

- **SyncCycleScheduler**: runExclusiveRepoOperation refuses a fail-fast caller while the per-repository mutex is busy, so an overlapping cycle's sync resolves in_progress without touching the repository. The mutex does not protect the bookkeeping the UI keeps outside the lock (such as recorded skips), which the scheduler must guard itself.
- **SyncCycleScheduler.runSyncServices**: runSyncServices calls clearRecordedSkips() before it knows whether the service can run, so an overlapping cycle reaching that call would wipe skips the running cycle still has to report; overlapping cycles must be kept out before that point.
- **SyncCycleScheduler**: A cron tick that lands while a cycle is in flight is skipped entirely before reaching the services, so it neither attempts a second sync nor calls clearRecordedSkips(), which would wipe skips the in-flight cycle has recorded and must still report.

#### `src/services/__tests__/repo-operation-lock.state-dir.test.ts`

- **RepoOperationLock**: The repository lock location must not depend on per-shell variables such as XDG_STATE_HOME or HOME: a cron/systemd daemon with a minimal environment and a --runOnce from an interactive shell (or sudo without -E) must contend for the same lock file.

#### `src/services/__tests__/repo-operation-lock.test.ts`

- **isUnitTestShortcutEnabled**: A shell, CI job or .env exporting NODE_ENV=test must never switch off cross-process repository locking; only the tool-owned unit-test shortcut may.
- **RepoOperationLock.acquire**: Only sync-worktrees trash --restore/--purge --wait asks the lock to retry. Periodic callers keep retries at 0: a cron tick that cannot take the lock skips cleanly, because the holder is doing the same work.
- **RepoOperationLock.acquire**: Lock retries use a fixed 1s interval instead of proper-lockfile's exponential default, so the wait budget is a wall-clock time the CLI can quote to the person waiting.
- **RepoOperationLock.acquire**: In worktree mode the bare-repo and worktreeDir locks share a single wait window; giving each the full budget would double the worst case beyond what the caller asked for.
- **RepoOperationLock.acquire**: Once the shared wait window is spent, the second lock falls back to a single attempt, never a fresh budget and never a negative retry count.
- **RepoOperationLock.acquire**: When the lock directory cannot be created (SYNC_WORKTREES_LOCK_DIR pointing at a file, an unwritable parent), mkdir fails before any lock attempt and nothing holds the lock, so the result is lock_unavailable rather than locked.

#### `src/services/__tests__/worktree-status.process-budget.test.ts`

- **WorktreeStatusService**: One status snapshot fans out to four git commands at once and then more, and the prune phase requests maxStatusChecks snapshots in parallel, so the setting bounds git processes only if every command shares a single budget. The tests therefore count commands in flight rather than worktrees.

#### `src/services/__tests__/worktree-sync.repo-mutex.test.ts`

- **WorktreeSyncService.initialize**: The daemon starts a sync and arms cron jobs together, so a tick can arrive while a repository's first initialize() is still running. isInitialized() is an in-process flag both callers see as false; the fail-fast repository mutex is what stops the second caller, which logs and returns.
- **WorktreeSyncService.isSyncInProgress**: isSyncInProgress reports true for queued repository operations as well as running ones, so a config reload waits for queued work too.
- **WorktreeSyncService.runQueuedRepoOperation**: An unwritable lock state directory is not contention: no other process holds the lock and the operation simply cannot run. The result carries the path and errno as lock_unavailable, logged as an error that does not blame another process.
- **WorktreeSyncService.purgeTrashEntry**: Trash restore and purge queue on the in-process mutex, and the cross-process lock is taken fail-fast by default but with a bounded wait budget under --wait, so a restore attempted during a daemon sync need not fail for a reason that clears within a minute.

#### `src/services/__tests__/worktree-sync.service.test.ts`

- **WorktreeSyncService git maintenance**: Git maintenance (gc) runs inside the repository lock and must complete before the cross-process lock is released, because after release another process may already be mutating the repository.

#### `src/services/__tests__/worktree-sync.trash-size-off-lock.test.ts`

- **WorktreeSyncService.sync trash sizing**: Trash entry sizing runs du over a whole worktree, so it must never run while the repository operation lock is held; every other sync, MCP call and interactive action would be refused or queued for the duration.

#### `src/utils/__tests__/lock-path.test.ts`

- **getWorktreeDirLockTarget**: A systemd/launchd/cron daemon with a minimal environment, a --runOnce from a shell exporting XDG_STATE_HOME, and sudo -E versus plain sudo all see different HOME/XDG_STATE_HOME yet must contend for one lock file, so the lock target must not depend on them.

## Consequences

Changing code covered by an entry here means updating the entry in the same pull request. An entry that no longer holds is deleted, or superseded by a new numbered ADR when the reversal is itself a decision worth keeping.
