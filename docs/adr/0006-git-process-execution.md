# ADR-0006: Running git

- **Status:** Accepted
- **Date:** 2026-11-20
- **Source:** 172 code comments as of `5f17242`, moved here by [ADR-0001](./0001-record-decisions-in-adrs-not-comments.md)

## Context

Every operation shells out to git through simple-git. Git's behaviour depends on environment variables, the user's config, hooks, credential helpers and locale, and its failures are reported as text. These decisions cover how git is invoked, how long it may run, what environment it sees and how its errors are classified.

## Decisions

Grouped by the file that implements them, source before tests. Each entry names the symbol it governs.

### `src/cli/doctor.ts`

- **runGitNonInteractive**: Doctor runs git with spawn detached into its own session, which simple-git cannot do, so ssh cannot open /dev/tty for a passphrase or host-key prompt and fails at once instead of hanging; GIT_TERMINAL_PROMPT=0 only covers git's own prompts. It uses the same sanitized environment as sync clients with prompts forced off.
- **runGitNonInteractive**: On timeout the whole process group is killed, because git's ssh or remote-https helper would otherwise outlive git and keep the output pipes open.

### `src/components/FuzzySwitcher.tsx`

- **LOAD_CONCURRENCY**: FuzzySwitcher runs git worktree list for at most four repositories at a time, so a config with dozens of repositories does not spawn dozens of git processes the moment the switcher opens.

### `src/constants.ts`

- **GIT_CONSTANTS.MISSING_BASE_DIR_ERROR**: simple-git validates baseDir when a client is constructed and rejects with 'Cannot use simple-git on a directory that does not exist'; like spawn git ENOENT from an existing client, it means the working directory is gone.
- **DEFAULT_CONFIG.RETRY.JITTER_MS**: Retry jitter defaults to 0 and is read by SyncRetryPolicy: jitter only helps when many repositories retry in lockstep, so it is opt-in via retry.jitterMs rather than a delay nobody asked for.
- **ENV_CONSTANTS.GIT_OPTIONAL_LOCKS**: Setting GIT_OPTIONAL_LOCKS=0 stops read-only git commands such as git status and git diff from refreshing the index as a side effect.

### `src/services/bare-repo.service.ts`

- **BareRepoService.dropClonedBranchCopies**: Dropping a fresh bare clone's refs/heads copies runs git branch -D in batches of 200 names, so a repository with thousands of branches costs a handful of packed-refs rewrites instead of one per ref while staying well below any platform's argument-length limit.
- **BareRepoService.assertBareRepoOriginMatches**: git config --get on an unset key exits 1 with empty stderr, which simple-git resolves as an empty string rather than rejecting.
- **BareRepoService.dropClonedBranchCopies**: symbolic-ref -q HEAD is safe even though simple-git resolves its silent exit 1 as an empty string, because empty means no branch to protect, which is exactly what a detached HEAD is.
- **BareRepoService.detectDefaultBranch**: Asking the remote for its HEAD is the only remote-talking command in default-branch detection, so it runs on the network client while the caller's bare client is the local one.

### `src/services/branch-ref.service.ts`

- **BranchRefService remote commit lookup**: Remote commits are resolved through the bare repository so the lookup does not depend on the main worktree path existing.
- **BranchRefService.refExists**: refExists takes the caller's git client so the probe runs wherever its operation runs; worktree creation passes the bare repo's LFS-aware client.
- **BranchRefService.refExists**: refExists does not use show-ref --quiet because simple-git resolves rather than rejects when git exits 1 with no output, so stdout is kept enabled to make a missing ref reject.

### `src/services/clone-sync/fast-forward-undo.ts`

- **MERGE_CLEANUP_PATH_BATCH**: Paths are passed to ls-tree, hash-object and restore in batches of 200 while undoing a rejected fast-forward, because although the set is usually small, an upstream commit whose failing path sorts last leaves every changed file behind and one command line must fit the platform argument limit.
- **hashFileBatch**: hash-object prints one line per input in order; any other shape means the mapping cannot be trusted and the caller falls back to per-path hashing. Only the failure summary is logged because simple-git includes the command's stdout, which is the printed hashes, in the error.
- **restoreFilesFromHead**: Files are put back with restore --worktree rather than checkout HEAD --, because the rejected merge left the index alone so this is purely a working-tree edit, and because simple-git's progress plugin appends --progress to every checkout, which after -- git would read as another path.

### `src/services/clone-sync/fetch.ts`

- **fetchWithRecovery**: Any other LFS-retry error is propagated unchanged so the outer retry policy's LFS handling sees an accurate error.
- **unshallowIfDepthRemoved**: Clone-mode fetches pass --progress explicitly because simple-git's inactivity timer only resets on output, and with stderr piped git otherwise suppresses transfer lines and asks the server for no-progress. simple-git's progress plugin would add it anyway, but spelling it out keeps the argv under our control and consistent across fetches.

### `src/services/clone-sync/git-clients.ts`

- **CloneGitClients baseEnv**: Every clone-mode client carries baseEnv, which for the dry run's read-only service turns optional locks off so a clone's reads leave its index untouched.
- **CloneGitClients.localClientFor**: Clone-mode local commands run without an inactivity timeout because simple-git's block timeout only resets on output, and git is legitimately silent for minutes while a merge or checkout materializes a large tree; killing it would fail a sync that would have succeeded.
- **CloneGitClients.networkClientFor**: Clone-mode network commands (fetch, ls-remote) keep fetchTimeoutMs as an inactivity guard because silence there means a stalled connection or an unanswerable prompt; an undefined directory runs ls-remote against a URL.
- **CloneGitClients.unshallowClientFor**: The unshallow fetch runs on the clone timeout instead of the fetch timeout because it transfers what the initial clone skipped. The budget is an inactivity window kept fed by --progress during streaming; what it must cover are git's silent phases at either end (boundary computation and object enumeration, then the connectivity check), which scale with total history. docs/internal/clone-mode-notes.md notes this is reasoning, not a measurement.
- **CloneGitClients.buildGitEnv**: Per-client environment additions are layered over the sanitized process environment by createGitClient, which also forces the C locale that missing-remote-ref and LFS error classification depend on; ssh remotes also get askpass settings (sshNoPromptEnv) so ssh never waits on a prompt.
- **CloneGitClients.assertPrimaryCheckout**: git prints git-dir paths relative to the directory it ran in when inside it (a plain clone prints .git twice) and absolute otherwise, so they are resolved against the checkout rather than the process cwd.

### `src/services/clone-sync/git-helpers.ts`

- **asLiteralPathspec**: Candidate paths from git diff --name-only are filenames, not patterns, so they are wrapped in :(literal); otherwise a leading colon is read as pathspec magic, ls-tree matches nothing and still exits 0, and the undo's origin-no-longer-holds-it proof would become no proof.
- **summarizeGitFailure**: Git failures are condensed to the last fatal: or error: line, because a clone failure's stderr carries the whole transfer log including carriage-return-separated progress lines.
- **hasRemoteBranch**: hasRemoteBranch does not pass --quiet to show-ref because simple-git resolves a silent exit 1; keeping stdout makes a missing ref reject, which the post-fetch missing_remote_ref skip depends on.

### `src/services/clone-sync/remote-config.ts`

- **readRemoteConfigValues**: git config --get-regexp prints keys lower-cased, and a key set without a value is printed alone with no newline, so the parser handles both.
- **evaluateOriginMatch**: git config --get on an unset key exits 1 with empty stderr, which simple-git resolves as an empty string rather than rejecting.

### `src/services/git-maintenance.service.ts`

- **GitMaintenanceService**: Periodic git gc reclaims unreachable objects (left by clone-mode ref narrowing and branch churn) and consolidates packs, throttled by a persisted timestamp so daemon restarts or repeated runOnce invocations do not rerun it every tick. Callers must already hold the repository operation lock; runIfDueUnlocked mirrors WorktreeSyncService.initializeUnlocked and never re-acquires it.
- **GitMaintenanceService state file read**: The maintenance state file is rejected unless it is a plain object, because spreading into a fresh object means a corrupt file such as [] cannot swallow the lastAttemptAt written to it, which would break throttling and rerun gc every sync.
- **GitMaintenanceService.runIfDueUnlocked**: runIfDueUnlocked runs git gc when enabled and due, must be called with the repository lock held, and never throws: a gc failure is recorded and warned so it cannot fail the sync, and the attempt timestamp is persisted even on failure so a perpetually failing gc is throttled.
- **GitMaintenanceService.runNowUnlocked**: An explicit maintenance request bypasses isEnabled and isDue so it always attempts gc, with the repository lock held by the caller, and prunes on a grace window rather than --prune=now unless maintenance.aggressive is set; MAINTENANCE_CONSTANTS.FORCE_CLEAN_PRUNE_EXPIRE documents why the window does not cost the reclamation.
- **GitMaintenanceService.buildArgs**: Plain gc honours git's two-week prune grace while --prune=now honours none, so --prune=now is reserved for the maintenance.aggressive flag that documents the hazard; an explicit run without it still prunes, but not into the window where a concurrent git command's objects live.
- **GitMaintenanceService.runUnlocked**: Maintenance runs at the tail of sync and is best-effort, so every failure (target resolution, state IO, gc itself) is swallowed and can never fail an otherwise successful sync.

### `src/services/git-service.types.ts`

- **GitServiceContext**: GitServiceContext is what GitService shares with its composed services (WorktreeCreationService, WorktreeRegistryService, BranchRefService, BareRepoService, LfsVerificationService). Mutable state such as the logger, default branch and per-sync LFS override is read through getters on every use so changes on GitService reach all modules without rewiring, and client accessors hand out GitService's own cached clients.

### `src/services/git.service.ts`

- **GitService.probeStatusService**: GitService keeps a separate status service with optional locks off for callers that only report, such as MCP read-only tools, so their probes do not refresh worktree indexes.
- **GitService constructor**: A read-only GitService (the dry run's) sets GIT_OPTIONAL_LOCKS=0 because git status and git diff otherwise refresh a worktree's index as a side effect, and a read-only service must leave the repository exactly as it found it.
- **GitService.createContext**: The GitServiceContext handed to sub-services reads current values through accessors, so updateLogger, a default-branch switch and setLfsSkipEnabled reach them without rewiring.
- **GitService.createUncachedGit**: Uncached git clients are used for the bare clone (no repository yet), ls-remote against a URL, and one-off environments such as LFS verification's GIT_ATTR_SOURCE.
- **GitService.getCachedClient**: Each path gets one cached client per LFS-env and kind combination; local and network kinds differ only in inactivity timeout, and the kind is part of the cache key so a local command never inherits the network client's kill or vice versa.
- **GitService.buildGitEnv**: Client environments are layered over the sanitized process environment by createGitClient, which forces the C locale every stderr match (stale info, missing ref, LFS) depends on; ssh remotes also get askpass settings via sshNoPromptEnv so ssh never waits on a prompt.
- **GitService.forgetCachedClients**: Cached clients for a path that stopped being a worktree (removed, trashed, quarantined, preserved) are dropped, because nothing else releases them and a daemon otherwise grew with branch churn at about 7 KB per client (measured). The status service is cleared alongside since it keys clients by the same paths; dropping entries never disturbs an operation already holding a client.
- **GitService.getCachedGit**: Local git commands run without an inactivity timeout because simple-git's block timeout only resets on output and git is silent for minutes during worktree add on a large repository or LFS smudging; a silence-based kill would abort creations that would succeed, every tick.
- **GitService.getCachedNetworkGit**: Network git commands (fetch, push, ls-remote, remote set-head) keep fetchTimeoutMs as an inactivity guard, since silence there means a stalled connection or unanswerable prompt that would otherwise hang the sync.
- **GitService.fetchBranch**: Single-branch fetches name refs/heads/<branch> because a short name would resolve to a same-named tag first.
- **GitService.fetchFromAnchor**: Fetches run in the default branch's worktree; if it vanished after ensureAnchorWorktree's check, git fails with spawn ENOENT or simple-git's directory-does-not-exist error depending on whether the client was cached, so client construction is inside the try and both are rephrased, after a confirming probe, to name the missing directory.
- **GitService.classifyRemoteRelationship**: classifyRemoteRelationship is the one place a local ref's relationship to its remote is derived, so sync ticks (HEAD) and clone-mode branch switches (refs/heads/<branch>) cannot drift. It deliberately avoids merge-base --is-ancestor because that reports only by exit code with empty stderr, which simple-git resolves as an empty string for both answers.
- **GitService.classifyRemoteRelationship**: simple-git swallows merge-base's exit 1 and returns an empty string, so empty output is treated as failure too.
- **GitService.getChangedPathsInRange**: Paths from git diff output are not trimmed because leading or trailing whitespace is valid in POSIX paths and core.quotePath=false does not quote whitespace; only a trailing CR from Windows line endings is stripped.

### `src/services/lfs-verification.service.ts`

- **LfsVerificationService.verifyLfsFilesDownloaded**: git lfs ls-files reads the index and .gitattributes, so it is a local command and runs without an inactivity timeout, like the cached local client.

### `src/services/worktree-creation.service.ts`

- **ALREADY_REGISTERED_WORKTREE**: Worktree creation detects git's 'already registered worktree' error text, which git emits when `worktree add` targets a path it already has a registration for, whether live or left by a directory deleted out-of-band.
- **WorktreeCreationService.clearStaleWorktreeDirectory**: Cached git clients for the path are dropped before clearing a stale directory, since every outcome removes or replaces the directory; the refusal paths only cost a rebuilt client.

### `src/services/worktree-metadata.service.ts`

- **WorktreeMetadataService.updateLastSyncFromPath**: The current branch is read with `git symbolic-ref -q HEAD` instead of simple-git's branch(), which runs `git branch -v -a` and walks every branch.

### `src/services/worktree-registry.service.ts`

- **WorktreeRegistryService.getWorktreesFromBare**: getWorktreesFromBare takes the caller's bare-repository client because worktree creation lists through its LFS-aware client while everything else uses the plain one.

### `src/services/worktree-status.service.ts`

- **WorktreeStatusServiceConfig.maxConcurrentGitProcesses**: maxConcurrentGitProcesses caps the git processes the status service runs at once across every worktree, defaulting to maxStatusChecks.
- **WorktreeStatusService.collectSnapshot**: Whether HEAD is at or behind the recorded remote tip is tested by zero commits in <tip>..HEAD, not `merge-base --is-ancestor`, because simple-git treats its silent exit 1 as success. Any failure reads as 'not proven', and the probe runs only once the recorded ref is gone, reusing the since-sync count when the range is identical.
- **WorktreeStatusService.readCurrentBranch**: `symbolic-ref -q HEAD` is used because on a detached HEAD it exits 1 silently, which simple-git resolves as an empty string rather than an error.
- **WorktreeStatusService.listStashes**: stashList is called with a cast because simple-git types its options as flat CLI options, although it parses a `format` map exactly as for `git log` and returns the fields on each entry.
- **WorktreeStatusService.countOwnStashes**: Stash entries are read from listing.all because simple-git derives total from all.length, so every entry is present.
- **WorktreeStatusService.isInHeadHistory**: Ancestry of a stash base is tested by zero commits in HEAD..<oid> rather than `merge-base --is-ancestor`, because simple-git resolves its silent exit 1 as success; any failure answers true, the conservative side for a safety gate.
- **WorktreeStatusService.createGitInstance**: Status git clients carry the sanitized process environment, because without HOME or XDG_CONFIG_HOME git ignores the global excludes file and globally ignored files read as untracked changes, and without PATH the spawn can fail.
- **WorktreeStatusService.forgetWorktree**: GitService calls forgetWorktree on every removal to drop the status client cached for that path; clients are cached per worktree path, so otherwise the cache grows with every branch the repository ever had.

### `src/services/worktree-sync.service.ts`

- **WorktreeSyncService.initializeUnlocked**: Initialization failures get their git credential/ssh remedy hint attached once where they leave the service, because every consumer (run-once, cron, TUI, MCP) reports the rejection's message.
- **WorktreeSyncService.forceClean**: Force clean probes for in-flight git commands and half-finished operations and skips gc if any are found, because gc rewrites the shared object store and can collide with a user's own commit, unlike the ref and directory deletions git serializes. The probe is point-in-time, not exclusion, so it catches lasting states (conflicted merge, interactive rebase, held index.lock); skipped objects are collected at the next maintenance run.
- **WorktreeSyncService.deleteKeepRef**: Single keep-ref deletion uses the same listing checks as the batch because `update-ref -d` exits 0 for a missing ref.
- **WorktreeSyncService.sync**: Initialization inside a sync runs under the same retry policy as the sync attempt, since init fetches or clones and a briefly unreachable remote should be retried.
- **WorktreeSyncService.sync**: A sync failure gets its credential/ssh remedy hint attached once, so the outcome, the log line and the rejection all carry it.

### `src/types/index.ts`

- **Config.fetchTimeoutMs**: fetchTimeoutMs is an inactivity timeout (default 5 minutes, 0 disables) for remote-facing commands (fetch, push, ls-remote, remote set-head) that kills a command when no output arrives in the window. Local commands never carry it because they are legitimately silent during large checkouts, and the unshallow fetch uses cloneTimeoutMs instead.
- **Config.cloneTimeoutMs**: cloneTimeoutMs is the inactivity timeout (default 15 minutes, 0 disables) for `git clone` and the clone-mode `fetch --unshallow`, larger than the fetch timeout because server-side pack resolution can be silent for minutes on big repositories.

### `src/utils/git-auth-error.ts`

- **GIT_AUTH_ERROR_PATTERNS**: Every git subprocess runs non-interactively, so a remote that refuses credentials or needs a prompt can never succeed. These git/ssh stderr fragments are matched as substrings to recognise that class of failure.
- **withGitAuthHint**: withGitAuthHint wraps an auth failure in a new Error carrying the remedy hint and keeps the original as cause, so logs that inspect the error still show git's stderr and the failed command.

### `src/utils/git-busy-probe.ts`

- **HEAD_LOCK**: HEAD.lock is treated as a busy marker because it covers the ref-update instant when a commit's objects exist but nothing references them yet. Sampling a commit loop 200 times found index.lock in 8.5% and HEAD.lock in 2.5% of samples with no overlap, and checking it costs no extra syscall.
- **BUSY_MARKERS**: index.lock and HEAD.lock signal an in-flight git command; the merge, cherry-pick, revert, bisect and rebase markers are states a person will return to finish. A marker left by a crashed command reports busy until cleared, so the caller names the marker it found.
- **describeWorktree**: Busy signals report the checkout path read from <gitDir>/worktrees/<name>/gitdir rather than git's admin directory name, which is only a basename and gains a numeric suffix when two checkouts share one.
- **markersIn**: Busy markers are found with one directory listing rather than a probe per marker, because index.lock exists for milliseconds and fewer syscalls narrow the window; it also treats lockfiles and rebase directories uniformly.
- **markersIn**: Any listing error other than a missing directory means markers cannot be read and one might be present, so the checkout is reported as busy with an unreadable marker instead of idle.
- **probeInFlightGitOperations**: The git dir itself is probed because in clone mode it is the checkout's own .git; in a bare repository the markers never appear normally, so one showing up means someone is running git against the bare repo.
- **probeInFlightGitOperations**: A missing worktrees/ directory is the normal shape of a repository without linked worktrees, including clone mode, so it yields no signals.
- **probeInFlightGitOperations**: If worktrees/ exists but cannot be read, every checkout behind it is unaccounted for, so an unreadable signal is reported rather than assuming idle.

### `src/utils/git-client-cache.ts`

- **GIT_CLIENT_CACHE_LIMIT**: The client cache bound is a backstop, not the eviction mechanism: paths that stop being worktrees are dropped explicitly via GitService.forgetCachedClients, and the bound only stops forgotten paths from being retained for a daemon's lifetime. It counts entries (a path can have several variants), so 512 is roughly 170-256 worktrees, and a rebuild past it costs only an object and a stat, never a git process.
- **GitClientCache**: Cache keys join the directory and variant with NUL because NUL cannot appear in a path on any supported platform, so no directory name can be misread as a directory plus a variant.
- **GitClientCache**: Clients are cached per resolved directory plus variant (LFS env and timeout combination), with the path stored as a field so forget can drop every variant of a dead worktree at once. Forgetting only removes map entries; a client already handed out keeps working because the caller holds it and simple-git's scheduler lives on the instance.
- **GitClientCache.get**: A cache hit is re-inserted so Map insertion order acts as LRU and the bound evicts the least recently used entry. Frequently used shared clients (bare repo, anchor worktree) are thus the last to be evicted, which matters because a shared client is also what caps how many git processes a phase runs at once.

### `src/utils/git-client.ts`

- **SIMPLE_GIT_CLIENT_CONCURRENCY**: simple-git schedules per client and no client overrides maxConcurrentProcesses, so the cap is simple-git's default of 5. It bounds nothing across clients, but every call through one shared cached client (anchor-worktree fetches, worktree add/remove via the bare repo) is capped at 5 regardless of requested concurrency.
- **MAX_TIMER_DELAY_MS**: Node timers hold at most 2^31-1 ms; a larger delay makes Node warn and substitute 1 ms, so an oversized inactivity timeout would kill every guarded git command immediately. Timeouts are clamped to this value.
- **GIT_LOCALE_ENV**: Every git client forces LC_ALL=C and LANG=C because callers match git's message text (no upstream, unknown revision, stale info, LFS and missing-ref errors) and those matches silently fail under a non-English locale. LANGUAGE needs no override since gettext ignores it under the C locale.
- **buildGitClientOptions**: Every simple-git client must be built with the centralized unsafe-env allowances, because every client passes an explicit env and simple-git rejects an explicit env containing an unallowed variable before spawning git.
- **buildGitClientOptions**: The config loader already rejects out-of-range timeouts, but a Config built in code bypasses it, so buildGitClientOptions clamps the block timeout to the Node timer maximum to stop it wrapping into an instant kill.
- **createGitClient**: createGitClient is the single way to build a simple-git client: it applies the sanitized parent env (non-interactive, no repository-selection variables that would outrank baseDir), then the C locale, then caller additions such as GIT_LFS_SKIP_SMUDGE last so deliberately passed variables still reach git.

### `src/utils/git-env.ts`

- **GIT_UNSAFE_ALLOWANCES**: simple-git refuses to spawn when an explicit env contains git-honoured variables without the matching unsafe allowance. Because every client forwards the user's own sanitized environment, allowances are enabled for each env variable the parser maps (askpass, config env count and paths, credential helper, external diff, proxy, pager, ssh command, template dir) so a shell exporting PAGER or CI exporting GIT_CONFIG_COUNT cannot break every git call. Editors are stripped instead, and argument-guarding allowances stay off so branch names and URLs in git arguments keep simple-git's protection; as a consequence a GIT_CONFIG_KEY_n naming a key outside this set is rejected for every client.
- **GIT_REPOSITORY_SELECTION_VARS**: simple-git only sets the child's cwd, so inherited variables like GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_NAMESPACE and GIT_CONFIG silently outrank a client's baseDir; measured on git 2.43 they redirect config writes, ref deletes, checkouts and fetched objects into another repository, and git hooks (linked-worktree post-checkout/commit/merge, receive hooks, pre-receive quarantine) export several of them without anyone asking. GIT_CEILING_DIRECTORIES and GIT_DISCOVERY_ACROSS_FILESYSTEM are stripped too since a client that knows its root gains nothing from them. Config-content variables, on-disk format variables, GIT_PREFIX, GIT_QUARANTINE_PATH and auth/discovery variables are deliberately kept.
- **stripGitRepositorySelection**: Repository-selection variables are stripped both for git subprocesses and for onBranchCreated hook commands, which run in the new worktree and would otherwise find a different repository. Deliberately passed variables survive because createGitClient merges its extraEnv after stripping.
- **sanitizeGitEnv**: simple-git's env() replaces the child environment wholesale, so git env starts from the parent env (PATH, HOME, SSH_AUTH_SOCK are needed), drops repository-selection variables, strips editors, and sets GIT_TERMINAL_PROMPT=0 unless the user set it, because git prompts on /dev/tty inside the Ink frame where it can never be answered. The ssh command is deliberately untouched since GIT_SSH_COMMAND outranks core.sshCommand (verified on git 2.43) and would override user configuration; ssh prompts are handled separately via sshNoPromptEnv's askpass variables.
- **PROMPT_DISABLED_VALUES**: The set of GIT_TERMINAL_PROMPT values treated as disabled mirrors the values git's own boolean parsing reads as false.
- **sshNoPromptEnv**: For ssh remotes, SSH_ASKPASS=false with SSH_ASKPASS_REQUIRE=force (OpenSSH 8.4+) makes ssh fail at once on passphrase, host-key or password prompts instead of hanging, without touching the user's ssh command. Nothing is added when the user exported SSH_ASKPASS or SSH_ASKPASS_REQUIRE, when git prompts are enabled, for non-ssh URLs (git would print an askpass error for HTTPS), or on Windows where askpass resolution differs and was not verified.

### `src/utils/git-progress.ts`

- **makeGitProgressHandler**: The simple-git progress handler emits at most one event per method/stage bucket, always emits 100%, and resets a bucket when progress regresses because cached clients reuse it for later fetches; its state is per handler, so each client needs its own. The logger is read per event via getLogger rather than captured, because clients are cached for the service's life and the TUI swaps the logger in later, so a captured logger would keep writing to the console under Ink's alternate screen.

### `src/utils/lfs-error.ts`

- **MISSING_REMOTE_REF_PATTERNS**: Missing remote refs (for example a tracked branch deleted on the remote) are detected by substring-matching git stderr. That only works because git is run with LC_ALL=C, keeping the messages in deterministic English.

### `src/utils/retry.ts`

- **RetryOptions.signal**: Aborting the retry signal stops retrying: no new attempt starts and a pending backoff sleep ends early.
- **retry DEFAULT_OPTIONS.shouldRetry**: simple-git's inactivity kill for fetchTimeoutMs/cloneTimeoutMs surfaces as plugin "timeout" or a "block timeout reached" message, and such errors are retried.
- **retry DEFAULT_OPTIONS.shouldRetry**: Authentication and host-key failures are checked before the generic remote-repository patterns, which those messages also contain, and are never retried because retrying cannot help and costs minutes of backoff.

### `src/utils/worktree-list-parser.ts`

- **ParsedWorktree.lockReason**: lockReason is kept single-line and log-safe: an ordinary reason is verbatim, while one with newlines, quotes, backslashes or control characters is double-quoted with C escapes. git applies quote_c_style itself in newline-terminated output, but -z output carries the raw reason, so the parser applies the same quoting.
- **readWorktreeListPorcelain**: Once a git older than 2.36 refuses worktree list -z, the refusal is remembered for the process so later listings go straight to the newline form.
- **readWorktreeListPorcelain**: Worktree listing uses NUL-terminated porcelain output when supported, because the newline form prints a path containing a newline raw and splits the record. The newline form is only a fallback for git older than 2.36, which rejects -z with unknown switch.
- **quoteCStyle**: quoteCStyle reproduces git's quote_c_style for single-line values: the value is verbatim unless it contains a double quote, backslash or control character, in which case it is quoted with C escapes.

### Tests

Why the tests that pin these decisions are built the way they are.

#### `src/__tests__/e2e/auth-prompt-disabled.e2e.test.ts`

- **git client environment (GIT_TERMINAL_PROMPT)**: git prompts for credentials on /dev/tty whenever a terminal is attached, regardless of stdio pipes, so a remote without a usable credential helper printed 'Username for ...:' into the TUI and hung until the 300 s inactivity timeout. Every git subprocess runs with GIT_TERMINAL_PROMPT=0 so git fails within a second with 'terminal prompts disabled' and the run reports what to configure.

#### `src/__tests__/e2e/insteadof-origin.e2e.test.ts`

- **bare/clone origin check**: `git remote get-url origin` applies url.<base>.insteadOf rewrites while the stored remote.origin.url is the configured repoUrl, so the origin check compares the stored value; comparing the rewritten URL reported a mismatch on every run after the first (worktree mode failed, clone mode skipped forever).

#### `src/__tests__/e2e/skip-lfs-global-ignore.e2e.test.ts`

- **skipLfs git client environment**: simple-git replaces the child environment wholesale when given an env, so the skipLfs status-probe client must carry the full environment plus GIT_LFS_SKIP_SMUDGE; with only that variable git loses HOME/XDG_CONFIG_HOME, ignores the global excludes file, and a globally ignored file makes a worktree read as dirty and blocks pruning.

#### `src/__tests__/e2e/ssh-prompt-disabled.e2e.test.ts`

- **git ssh environment (SSH_ASKPASS_REQUIRE)**: ssh reads key passphrases and host confirmations from /dev/tty itself, so GIT_TERMINAL_PROMPT=0 does not stop it and a passphrase-protected key without an agent hung clones until the 300 s inactivity timeout. git for ssh remotes runs with SSH_ASKPASS_REQUIRE=force and a failing askpass so OpenSSH 8.4+ gives up at once, without altering the user's configured ssh command; the e2e test uses a stand-in ssh reached via GIT_SSH_COMMAND that mimics that behaviour.

#### `src/__tests__/integration/branch-wizard-stale-remote.test.ts`

- **GitService.pushBranch**: pushBranch carries --force-with-lease on a fully-qualified refspec to refuse moving an existing remote ref, and `-u` must still set branch.<name>.remote and .merge as before; only a real push can show that.

#### `src/__tests__/integration/fetch-branch-tag-collision.test.ts`

- **GitService.fetchBranch**: `git fetch origin <name>` resolves a short name through refs/tags/ first, so a branch sharing its name with a tag was never fetched (FETCH_HEAD got the tag and refs/remotes/origin/<name> stayed put); fetchBranch uses an explicit refs/heads/<name> refspec.

#### `src/__tests__/integration/inherited-git-dir.test.ts`

- **GIT_REPOSITORY_SELECTION_VARS**: Repository-selection variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES) outrank the cwd simple-git sets and can be inherited from a shell, a CI job, or a git hook running inside a linked worktree, so they are stripped from every git invocation. For GIT_DIR and GIT_COMMON_DIR the strip turns a primary-checkout ConfigError refusal into a working sync; the work-tree, index and object-store variables are invisible to that guard, so the strip is what stops a tick writing into a foreign repository.
- **advanceRemote**: The inherited-GIT_DIR test pushes a remote commit no local repository holds so the tick must fetch real objects; without new objects a misdirected GIT_OBJECT_DIRECTORY would have nothing to swallow and the test could not detect it.
- **inherited-git-dir test**: An inherited GIT_OBJECT_DIRECTORY (as handed to pre-receive hooks) would make the fetched commit land in a foreign object store, leaving origin/main pointing at a missing object. Resolving the fetched commit in the checkout after the foreign variables are removed proves the objects were written into the checkout itself.

#### `src/__tests__/integration/local-op-inactivity-timeout.test.ts`

- **GitService local vs network clients**: simple-git's timeout.block resets only on stdout/stderr data, and `git worktree add` is silent while checking out a large repository, so a checkout longer than fetchTimeoutMs was killed with SIGINT on every tick. Local commands therefore run on git clients built without the inactivity kill, while network commands keep it.
- **GitService timeout options**: A fetchTimeoutMs of 0 means no inactivity kill rather than an immediate kill: simple-git only installs its timeout plugin for a positive block value, and the services only pass one when the configured value is positive.

#### `src/__tests__/integration/unshallow-inactivity-timeout.test.ts`

- **CloneSyncService unshallow**: Raising the unshallow budget to cloneTimeoutMs does not disarm the inactivity kill: `--progress` feeds the timer only while bytes are moving, so a wedged transfer still ends at the clone-sized budget.

#### `src/__tests__/integration/worktree-client-cache.test.ts`

- **GitClientCache**: GitService and the status service cache one simple-git client per worktree path, and a path lives only as long as its branch, so every flow that unregisters a worktree must evict that path's clients; otherwise a long-running daemon leaks clients for every branch it ever touched. Only driving real removal flows against real git covers both the cache keys and every unregister path.

#### `src/services/__tests__/bare-repo.service.test.ts`

- **BareRepoService clone cleanup**: git clone --bare copies every remote branch into refs/heads, and the fetch refspec only updates refs/remotes/origin, so those copies stay frozen and a later worktree would check out a stale tip. They are deleted right after the clone, except the branch HEAD points at (used for the default-branch worktree), in batches because each branch -D rewrites packed-refs once.
- **BareRepoService clone cleanup**: Clone-time refs/heads copies are deleted before the fetch refspec is configured and remote refs are fetched.
- **BareRepoService origin check**: git config --get of an unset key exits 1 with empty stderr, which simple-git resolves as an empty string rather than rejecting, so an empty origin URL means unset.
- **BareRepoService.detectDefaultBranch**: refs/remotes/origin/HEAD is written only by git remote set-head, so after the remote renames or deletes its default branch, fetch --prune leaves the symref naming a missing branch. Default-branch detection trusts the symref only while its target is still one of the remote branches.

#### `src/services/__tests__/branch-ref.branch-config-cleanup.test.ts`

- **BranchRefService.removeBranchConfigSection**: The branch config section removal after a compare-and-swap delete catches every error, not only GitError: the non-git rejections (a torn-down client, env validation, a task timeout) are exactly the ones that must not surface, because the ref is already gone and reporting failure would be wrong.

#### `src/services/__tests__/branch-ref.ref-argument-separator.test.ts`

- **GitService ref wrappers**: Branch names and start points read from a trash manifest are passed to git, whose option parser permutes arguments, so an option-shaped value is taken as an option unless a -- separator precedes it. Measured on git 2.43, git branch -m with an oid renames the HEAD branch and git worktree add with --force or --detach in the branch position silently succeeds on the wrong target; these are silent wrong answers, so tests assert on surviving refs, not only on the throw.
- **GitService.createBranchAt**: git branch restored -m is parsed as git branch -m restored, so the manifest's headOid passed as a start point is as dangerous as its branch name and needs the same separator.
- **GitService.createBranchAt**: Branch names git creates happily (dots, slashes, non-ASCII, a bare @) must still be restorable, so a misplaced separator or a validator stricter than git must not reject them.
- **GitService.addWorktreeNoCheckout**: Without a separator, git worktree add with --force or --detach in the branch position succeeds and yields the wrong worktree (a new branch named after the directory, or a detached one), and restore would then overlay the trashed payload onto it.
- **GitService.deleteLocalBranch**: On git 2.43 no single option-shaped argument makes git branch -D delete anything unintended, so for deleteLocalBranch the separator only changes how the failure reads (branch not found instead of a usage error), and the test asserts only on that message.

#### `src/services/__tests__/branch-ref.ref-probes.test.ts`

- **GitService ref probes**: simple-git rejects only when a command exits non-zero and wrote to stderr, so probes that answer through exit code alone (show-ref --verify --quiet, merge-base --is-ancestor) would resolve for a missing ref. Ref probes therefore keep output enabled so a missing ref produces a fatal message on stderr.
- **GitService.branchExists**: If branchExists could not see a missing local ref it would answer local true, letting callers skip creating the branch; the remote-only case pins that it reports the absence correctly.

#### `src/services/__tests__/branch-ref.remote-ref-inventory.test.ts`

- **GitService remote branch inventory**: A local branch literally named origin/topic forces git to disambiguate refs/remotes/origin/topic, so refname:short prints remotes/origin/topic; the inventory must not rely on short names.

#### `src/services/__tests__/branch-ref.service.test.ts`

- **BranchRefService.createBranch**: Because branch filters mean a branch on origin often has no local head, git branch would collide with nothing and take the name anyway, so branch creation asks origin directly. The refusal is phrased already exists because that is the wording the TUI suffixes and retries on.
- **BranchRefService.createBranch**: create_worktree without a push works offline, and the create-only push lease is what actually protects the remote, so an origin probe that cannot reach the remote must not stop the branch from being created.
- **BranchRefService.pushBranch**: pushBranch uses --force-with-lease=ref: with an empty expectation, git's create-only push, so the remote ref must not exist. Without it the push would fast-forward a branch already on origin whenever its tip is an ancestor of the base, moving someone else's branch and any PR or CI pinned to it while reporting success.
- **BranchRefService.getRemoteBranches**: Remote branches are listed with for-each-ref on full refnames rather than branch -v -r, so no commit is resolved just to print a discarded subject line and the output is not shaped by color settings or short-name ambiguity.
- **BranchRefService.trackRemoteBranchIfExists**: Setting upstream tracking runs in the worktree, which is fine for a --no-checkout worktree because it only touches config, while the remote ref is looked up in the bare repository.

#### `src/services/__tests__/clone-sync.client-timeouts.test.ts`

- **CloneSyncService git clients**: Clone mode gives network commands (git fetch, ls-remote) simple-git's inactivity kill so a stalled connection cannot hang the sync, while local commands (ff-merge, branch switch, config rewrites) run without one. A merge that materializes a large tree can be silent for minutes and would otherwise be killed at fetchTimeoutMs.
- **CloneGitClients.getFetchTimeoutMs**: A timeout of 0 is the documented way to disable simple-git's inactivity kill, and it is falsy, so the timeout windows must be read with `config.x ?? DEFAULT_CONFIG.X`; using `||` would silently substitute the 5- and 15-minute defaults. With 0 the client must carry no timeout option at all, because simple-git only installs its timeout plugin for a positive block, which makes 0 a disable rather than an instant abort.

#### `src/services/__tests__/clone-sync.service.test.ts`

- **createAndPushCloneBranch**: Git commands for branch creation run in the clone with LC_ALL=C and LANG=C, because git error classification depends on English messages.

#### `src/services/__tests__/git.service.client-cache.test.ts`

- **GitService.forgetCachedClients**: Each cached git client costs about 7 KB (a simple-git instance plus its own copy of the sanitized environment) and the caches are keyed by worktree path, so a long-running daemon on a repository whose branches come and go would otherwise accumulate one client set per branch ever seen. Every path that stops being a worktree must drop its cached clients, while remaining worktrees keep theirs.

#### `src/services/__tests__/git.service.client-timeouts.test.ts`

- **GitService git clients**: simple-git's inactivity timeout (timeout.block) kills the child with SIGINT whenever no output arrives within the window, and git worktree add is silent for its entire checkout, so large repos were killed every tick. The timeout guards network stalls only, so just the clients that run network commands carry it; local commands use a client built without it.
- **BranchRefService.remoteBranchExists**: The branch-collision probe (ls-remote against origin) runs on the network client with the fetch block timeout. On the untimed local client a stalled connection has nothing to end it and the branch creation waiting on it hangs forever.
- **BareRepoService.detectDefaultBranch**: When origin/HEAD is unreadable, default-branch detection falls through to git remote set-head -a, its only command that contacts the remote, so that command must run on the network client with the fetch block timeout.
- **createGitClient**: Error classification matches git's own stderr (the 'stale info' lease rejection, missing remote ref, LFS errors), and those strings are translated. Every git client is forced to LC_ALL=C so that under a non-English locale a lease rejection is still recognised as a collision instead of a hard failure.
- **GitService client cache**: The git client cache keys local and network clients for the same path separately, so a local command can never be served the timed network client or vice versa; the test interleaves both kinds on one path to prove it.

#### `src/services/__tests__/git.service.logger-propagation.test.ts`

- **GitService.createContext**: The services GitService delegates to (worktree registry and creation, branch refs, bare repo, LFS) read the logger through the shared context on every call instead of holding a copy, so updateLogger reaches them without re-wiring.

#### `src/services/__tests__/git.service.test.ts`

- **GitService timeouts**: NODE_ENV is whatever the caller's shell or CI exported, so it must never disable git timeouts; only the dedicated unit-test shortcut env var may zero them.
- **createGitClient**: Every git client runs non-interactively: its env carries GIT_TERMINAL_PROMPT=0 so a credential prompt fails at once instead of blocking the TUI until the inactivity timeout, and its options carry the centralized unsafe-env allowances a forwarded shell environment needs. The test removes GIT_TERMINAL_PROMPT from process.env first so only the sanitizer can supply it.

#### `src/services/__tests__/interactive-ui.service.test.ts`

- **InteractiveUIOperations.createAndPushBranch**: The create-only push lease reports a name already on origin as 'stale info'; it is translated into a collision so the loop suffixes and retries instead of showing the user git's wording.

#### `src/services/__tests__/logger.service.test.ts`

- **Logger.error**: Without debug, a git failure is printed as its single 'fatal:' line instead of git's full stderr, simple-git's internal stack and the inspected task commands (about 30 lines for an unreachable remote).

#### `src/services/__tests__/worktree-creation.sparse-checkout.test.ts`

- **LfsVerificationService.verifyLfsFilesDownloaded**: The GIT_ATTR_SOURCE=HEAD client used for git lfs ls-files passes an explicit env, and simple-git validates explicit envs (GIT_ASKPASS, GIT_CONFIG_COUNT) that default clients inherit freely. That client needs the same unsafe-env allowances as getCachedGit's clients, otherwise a VS Code askpass bridge or CI config-count makes it throw and LFS verification is silently skipped.

#### `src/services/__tests__/worktree-status.service.test.ts`

- **WorktreeStatusService skipLfs client**: simple-git's .env() replaces the child environment wholesale, so the LFS-skip client used for status probes carries the sanitized process environment. Without HOME or XDG_CONFIG_HOME git skips the global excludes file and a globally ignored .DS_Store reads as an untracked change, blocking updates and pruning; without PATH the spawn can fail outright.

#### `src/services/__tests__/worktree-sync.service.test.ts`

- **SyncRetryPolicy**: A git credential or ssh failure cannot be fixed by retrying, so it is not retried with backoff; and since a user cannot act on git's message alone in a non-interactive run, the rejection, log line and outcome carry the credential-helper hint.

#### `src/utils/__tests__/git-busy-probe.test.ts`

- **probeInFlightGitOperations**: Clone mode has a single checkout and no worktrees/ directory, so the git dir's own markers are the only busy signals there and must be probed.
- **describeWorktree**: git writes an absolute path to the checkout's .git file, but a submodule or hand-made registration can point at something not named .git; the parent is taken only when the basename is .git, otherwise the path is reported as is.
- **markersIn**: A worktree registration directory that cannot be listed could be hiding any busy marker, so it is reported as unreadable rather than idle.
- **markersIn**: A registration that vanishes between listing worktrees/ and reading it (a concurrent git worktree remove or prune) is gone, not busy; reporting it as unreadable would wedge force clean's gc on a checkout that no longer exists.
- **markersIn**: A worktree registration that is a file rather than a directory (ENOTDIR) is a malformed registration, not a git command in flight, and must not permanently block gc.
- **markersIn**: One worktree can hold several markers at once, such as an abandoned interactive rebase with a command running inside it; since the error tells the user what to clear, every marker is reported, not just the first.
- **HEAD_LOCK**: HEAD.lock is held during the ref update, the instant a commit's objects exist but nothing references them; sampling showed it never overlaps index.lock, so dropping it would lose that window entirely.

#### `src/utils/__tests__/git-client-cache.test.ts`

- **GitClientCache tests**: Worktree directories are removed or trashed while the process keeps running, so the GitClientCache tests pin two memory properties: forgetting a path leaves nothing behind, and the cache stays bounded even for paths nobody forgets.

#### `src/utils/__tests__/git-env.test.ts`

- **sanitizeGitEnv**: simple-git only sets the child's cwd, so repository-selection variables outrank a client's baseDir, redirecting or bounding discovery. git hands GIT_DIR and GIT_INDEX_FILE to some of its own hooks, so a run started from a hook inherits them without anyone exporting anything.
- **sanitizeGitEnv**: While repository-selection variables are stripped, everything git needs to authenticate, find itself and read the caller's chosen configuration content must still reach git.
- **sanitizeGitEnv**: git prompts for credentials on /dev/tty whenever a terminal is attached, regardless of stdio pipes, and in the TUI that prompt can never be answered, so GIT_TERMINAL_PROMPT=0 is set.
- **sanitizeGitEnv**: git gives GIT_SSH_COMMAND precedence over core.sshCommand, so the tool never injects an ssh command; doing so would silently replace a user's configured one (includeIf keys, ssh -i, agent wrappers).
- **GIT_UNSAFE_ALLOWANCES**: GIT_UNSAFE_ALLOWANCES has one entry per environment variable @simple-git/argv-parser maps to an allowance, plus credential.helper via GIT_CONFIG_KEY_n, because a forwarded shell environment must never make a git call throw.
- **GIT_REPOSITORY_SELECTION_VARS**: The repository-selection variable list is spelled out literally in the test rather than derived, so adding or removing one is a deliberate edit with a reason; each entry is a variable git reads instead of the working directory, and everything else git honours stays.
- **sshNoPromptEnv**: git itself reads SSH_ASKPASS for HTTPS credentials, so setting it for non-ssh remotes would only print an askpass error ahead of terminal prompts disabled.
- **sshNoPromptEnv**: SSH_ASKPASS and SSH_ASKPASS_REQUIRE do not name an ssh command, so whatever core.sshCommand, GIT_SSH_COMMAND or GIT_SSH specifies still runs.

#### `src/utils/__tests__/retry.test.ts`

- **retry DEFAULT_OPTIONS.shouldRetry**: Authentication and ssh key/host-key failures are never retried because retrying cannot help, even though the ssh messages also contain Could not read from remote repository, which on its own is retryable.

#### `src/utils/__tests__/worktree-list-parser.test.ts`

- **parseWorktreeListPorcelain**: In newline-terminated output git runs the lock reason through quote_c_style, so a reason with newlines or quotes arrives on one line quoted and escaped; keeping it exactly as printed is what makes it safe to log.
- **parseWorktreeListPorcelain**: With -z git prints the lock reason raw, so the parser quotes it the way the newline form does to keep the value single-line and safe to log.

## Consequences

Changing code covered by an entry here means updating the entry in the same pull request. An entry that no longer holds is deleted, or superseded by a new numbered ADR when the reversal is itself a decision worth keeping.
