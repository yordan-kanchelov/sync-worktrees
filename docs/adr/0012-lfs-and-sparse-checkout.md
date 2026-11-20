# ADR-0012: Git LFS and sparse checkout

- **Status:** Accepted
- **Date:** 2026-11-20
- **Source:** 105 code comments as of `5f17242`, moved here by [ADR-0001](./0001-record-decisions-in-adrs-not-comments.md)

## Context

Repositories may use Git LFS and sparse checkout, both of which change what a checkout writes to disk and how it can fail. These decisions cover detecting, verifying and configuring them without breaking repositories that use neither.

## Decisions

Grouped by the file that implements them, source before tests. Each entry names the symbol it governs.

### `src/services/clone-sync.service.ts`

- **CloneSyncService.upstreamOutsideSparse**: Clone mode applies sparseCheckout.skipUpdateWhenOutsideSparse the same way worktree mode does: only in cone mode, and an unreadable diff never causes a skip.

### `src/services/clone-sync/clone-bootstrap.ts`

- **cloneFresh**: The progress stream carries the same LFS-skipped nuance as the log, because a TUI showing Clone successful for a tree holding pointer files would be untrue.
- **checkOutSparseClone**: A sparse clone is cloned with --no-checkout, so applying sparse checkout is its first checkout; the incomplete-clone marker brackets it like a normal clone's checkout, and an LFS failure gets the same single retry with smudging off.
- **buildCloneArgs**: Sparse clones are cloned with --no-checkout so only the cone is checked out, after the sparse patterns are set.
- **retryCheckoutWithLfsSkipped**: A clone whose objects landed but whose checkout failed is retried checkout-only with LFS smudging forced off, the same recovery fetchWithRecovery and worktree mode's worktree add use. It reports success as a boolean rather than throwing, because the caller already holds the clone's original failure and must report that one.

### `src/services/clone-sync/fast-forward-undo.ts`

- **readWorktreeDeviations**: Working-tree deviations are bucketed the way the undo must treat them; git never reports a skip-worktree entry as deleted, so the cleanup cannot try to materialize a path outside a sparse cone.

### `src/services/clone-sync/git-clients.ts`

- **CloneGitClients.lfsSkipFetchClient**: The retry of a fetch that died on an LFS error uses a network client with LFS smudging forced off, built fresh because the branded pair's clients carry the configured environment; requiring the brand keeps it within a directory already proved to be a primary checkout.
- **CloneGitClients.isLfsSkipEnabled**: LFS skipping is enabled by the configured skipLfs setting or by the per-sync override the retry policy installs on GitService after an LFS failure, so the retry's fetch and merge --ff-only really run with LFS downloads disabled.

### `src/services/clone-sync/sparse.ts`

- **applySparseCheckoutAfterClone**: A fresh sparse clone is narrowed with sparse-checkout set followed by checkout HEAD, so only in-cone paths are ever written or smudged. When the clone only succeeded with LFS skipped, both halves run with smudging forced off, since the configured environment would die on the skipped objects again; -f is used because a failed attempt may have left untracked files.
- **assessSparseCheckout**: When narrowing drops paths from the cone git keeps modified, staged and untracked files but warns only on stderr, which the tool never prints. Skipping a narrowing on a dirty tree is therefore the tool's documented promise (docs/sparse-checkout.md, Narrowing safety), as in worktree mode, and the deferred narrowing lands on the first tick with a clean tree.
- **assessSparseCheckout**: The sparse narrowing gate uses the same notion of clean as the fast-forward gate, uncommitted and untracked changes; unpushed commits are a separate clone-mode skip and their content is safe in the object store anyway.
- **reapplySparseCheckout**: A failure to reapply sparse patterns does not stop the tick, since the fetch and merge are what the sync is for, but it is recorded as a failure rather than only warned, because warning and exiting 0 every tick lets a sparse config git rejects stay broken unnoticed for weeks.

### `src/services/config-schema.ts`

- **sparseCheckoutSchema.skipUpdateWhenOutsideSparse**: skipUpdateWhenOutsideSparse must be a real boolean because the update phase reads it as !== false, so a string such as 'false' would enable the skipping it was meant to disable.
- **sparseCheckoutSchema**: Cone mode is the sparse default and git sparse-checkout set --cone dies on a leading slash or glob character, so include entries are validated against cone rules; unvalidated, every worktree was added and rolled back each tick with an error naming neither the entry nor the rule.

### `src/services/git.service.ts`

- **GitService constructor sparseCheckoutService**: sparse-checkout set re-materializes paths entering the cone and runs the smudge filter like a checkout, so the sparse service's clients carry the same LFS skip setting as other local commands, resolved per call so the per-sync override counts; with no environment, skipLfs repositories failed at the sparse step.
- **GitService.isLfsSkipEnabled**: isLfsSkipEnabled combines configured skipLfs with the per-sync override installed after an LFS failure, and is public because clone mode builds its own clients; reading only config.skipLfs there made the announced LFS-skipped retry smudge exactly like the failed attempt.

### `src/services/lfs-verification.service.ts`

- **LFS_VERIFICATION_SAMPLE_SIZE**: LFS verification reads back only five of a worktree's LFS files after checkout, because the question is whether the smudge filter ran at all, which a sample settles as well as reading every file.
- **LFS_FILTER_ATTRIBUTE**: A repository whose HEAD declares no filter=lfs attribute never had LFS content, so no LFS verification runs and no LFS warning is issued for it.
- **LFS_ATTRIBUTE_CACHE_LIMIT**: The LFS-attribute verdict cache is keyed by content-addressed tree oids that never go stale, so its 256-entry limit only bounds memory in a long-running daemon.
- **LfsVerificationService.isLfsVerificationDisabled**: LFS verification is skipped when skipLfs is configured, when the per-sync override is active after an LFS failure, or when GIT_LFS_SKIP_SMUDGE is inherited from the environment, because pointer files are then the expected outcome, not a fault.
- **LfsVerificationService.verifyLfsFilesDownloaded**: LFS content is checked once right after worktree add or clone, because git checkout, including git-lfs delayed checkout and post-checkout hooks, completes before the command returns. Re-reading samples every second for up to 30 seconds per worktree, as earlier releases did, turned a first sync of 100 branches whose LFS stayed pointers into about 50 minutes of sleeping.
- **LfsVerificationService.verifyLfsFilesDownloaded**: Only repositories that use LFS reach the git-lfs installation check, so a machine without git-lfs gets one warning per process, never per worktree and never for repositories without LFS content.
- **LfsVerificationService.headDeclaresLfsFilter**: Before running git lfs ls-files, which walks the whole index, verification checks whether HEAD declares an LFS filter. The answer is cached by HEAD's tree oid, which is content-addressed, so entries are right forever without invalidation and branches sharing a tree share the answer.
- **LfsVerificationService.headDeclaresLfsFilter**: A HEAD that cannot be resolved (unborn branch, checkout that never landed) means there are no checked-out files to verify, so the LFS check answers no.
- **LfsVerificationService.treeDeclaresLfsFilter**: LFS filter detection greps the tree rather than the working copy, because under sparse checkout most .gitattributes files are not on disk; a pathspec limits the search to those files anywhere in the tree.
- **LfsVerificationService.treeDeclaresLfsFilter**: simple-git resolves git grep's nothing-matched exit 1 as an empty string, while a real failure leaves the question open, so the check answers yes and verification runs, the safe choice.
- **LfsVerificationService.listCheckedOutLfsFiles**: Only LFS files actually on disk are sampled, because with sparse checkout GIT_ATTR_SOURCE=HEAD lists every LFS file HEAD declares, including out-of-cone files never written, which would report a checkout failure that never happened.
- **LfsVerificationService.sampleFiles**: LFS samples are picked with a partial Fisher-Yates shuffle so repeated syncs do not keep checking the same files.
- **LfsVerificationService.findPointerFiles**: Sampled LFS files that still hold a pointer or cannot be read are both reported, since either means the checkout did not materialize the content.
- **LfsVerificationService.holdsLfsPointer**: Pointer detection reads only the first bytes of a file, since a pointer is a small text blob starting with the git-lfs spec header while real content can be gigabytes.

### `src/services/sparse-checkout.service.ts`

- **compareUtf8**: Cone patterns are sorted by UTF-8 bytes rather than with JavaScript's default sort, because git sorts its pattern list by UTF-8 bytes and the default UTF-16 code-unit comparison orders astral characters against U+E000-U+FFFF characters the other way round.
- **modeFor**: modeFor computes the effective sparse-checkout mode without the warning resolveMode logs. Config validation and the apply step must both use it, because the validator refuses cone patterns git would refuse and so must judge against the same mode the apply step picks.
- **canonicalizeConePatterns**: Cone directories are reshaped the way `sparse-checkout set --cone` normalizes them (normalized, no trailing slash, deduplicated, UTF-8 sorted, parent-covered entries dropped), which is what `sparse-checkout list` prints back. The canonical form lets patternsEqual recognize an unchanged config instead of reapplying patterns and re-checking out HEAD every sync. No-cone patterns are left untouched because trailing slashes and order are significant there and git echoes them verbatim.
- **canonicalizeConePatterns**: Cone paths are normalized before entries covered by an included parent are dropped. Otherwise a path like `apps/../docs` would look like it lives under `apps`, be dropped, and remove `docs/` from every worktree that had it materialized.
- **normalizeConeDirectory**: A cone entry consisting only of slashes has no directory left after stripping trailing slashes, so it is kept exactly as written and git is left to report it.
- **coneRuleBroken**: Load-time cone validation mirrors exactly the four refusals of `git sparse-checkout set --cone` (verified on git 2.43.0 and 2.55.0): leading slash, leading '!', any of `*?[]`, and a path normalizing to outside the root; other odd-looking paths git accepts are allowed. `.` is additionally refused because it selects only root files and `list` prints nothing, so it never reads back as in sync. The `--skip-checks` and 'is not a directory' refusals are not mirrored because the flag is never passed and the latter depends on index state at apply time; `exclude` needs no check because any exclude demotes the config to no-cone.
- **SparseCheckoutService.applyToWorktree**: applyToWorktree accepts an optional git client because `sparse-checkout init`/`set` touch the working tree and run the smudge filter; a caller whose checkout only succeeded with LFS smudging disabled must run init and set with the same client, or it fails on skipped objects and leaves a half-narrowed tree. All other methods only read config and use the service's own factory.
- **SparseCheckoutService.applyToWorktree**: Patterns are passed to `sparse-checkout set` after `--` because a directory name beginning with a dash is otherwise parsed as an option: git 2.55 dies on `-apps` with an unhelpful 'unknown switch', and all versions read directories named `--skip-checks`, `--cone` or `--no-cone` as flags, silently disabling checks or changing mode. After `--` every argument is the configured path the load-time rules validated.
- **SparseCheckoutService.readCurrent**: readCurrent takes the worktree's current sparse mode because `sparse-checkout list` C-quotes cone output, which must be unquoted, while no-cone output is the pattern file verbatim.
- **SparseCheckoutService.readCurrent**: `sparse-checkout list` runs with core.quotePath=false so non-ASCII stays unescaped, but git still C-quotes lines containing a backslash or quote, so cone lines are still unquoted afterwards.
- **SparseCheckoutService.isNarrowing**: Switching a worktree from cone to no-cone mode always counts as narrowing, because a no-cone pattern list drops the root files and parent-directory files that cone mode includes implicitly.
- **SparseCheckoutService.pathsTouchSparse**: Fast-forwards are skipped when upstream changes touch nothing materialised. Cone mode materialises every root file, every file directly inside each ancestor of an included directory (include `tools/build` keeps `tools/foo.txt`), and everything inside included directories; the matcher mirrors all three, because missing the ancestor-files case would leave stale parent files behind. No-cone configs always answer true (run the update). The matcher is cached per cfg object identity in a WeakMap, so callers should reuse the same cfg reference.

### `src/services/trash.service.ts`

- **TrashService.restoreAsWorktree**: A restored worktree gets the configured sparse-checkout profile reapplied, because the payload was checked out under it and without it git status would report every out-of-cone file as deleted.

### `src/services/worktree-mode-sync-runner.ts`

- **WorktreeModeSyncRunner.assessSparseAction**: The read-only sparse assessment decides whether a worktree's patterns need rewriting and whether that is safe; a narrowing hides files, so it is allowed only on a worktree that could be removed outright.
- **WorktreeModeSyncRunner.addWorktreeWithLfsFallback**: Fetching into a bare repository never runs the LFS smudge filter, so LFS failures surface in the checkout inside `git worktree add`, and the create phase's allSettled kept them from reaching retry()'s LFS handler. The LFS-skip fallback therefore happens per branch, bounded to one extra attempt, and only if the skip was not already on before the attempt.
- **WorktreeModeSyncRunner.withLfsFallback**: The update phase's fast-forward and the sparse re-apply also check files out, so they share the same one-retry LFS-skip fallback as worktree creation.
- **WorktreeModeSyncRunner.enableLfsSkipForSync**: The LFS skip is a GitService-wide switch (every client then carries GIT_LFS_SKIP_SMUDGE=1), restored by resetLfsSkipIfNeeded at sync end, so it is flipped once per sync rather than per branch. No lock is needed because nothing awaits between the read and the writes, so the first failing branch flips it and others retry under it.
- **WorktreeModeSyncRunner.assessUpdates**: If the diff used for the outside-sparse skip fails (null), the update proceeds rather than treating the failure as 'no sparse paths affected'.

### `src/utils/git-lfs-probe.ts`

- **git-lfs-probe**: Whether git-lfs is installed is a machine-wide fact that cannot change during a run, while LFS verification asks once per created worktree. To avoid a hundred probes and a hundred identical warnings on a first sync, the probe runs and the warning is emitted at most once per process.
- **isGitLfsInstalled**: isGitLfsInstalled runs the first caller's git lfs version probe and reuses the result; later callers' probes are never invoked because the answer does not depend on which repository asked. A rejection means git-lfs is not installed.
- **isLfsSmudgeSkippedByEnv**: git-lfs reads GIT_LFS_SKIP_SMUDGE as a git-style boolean, so truthy values leave pointer files as the expected outcome rather than a failed checkout; a CI job exporting it without skipLfs is the usual cause. The value is lower-cased but not trimmed, matching git-lfs, so a padded value that git-lfs ignores still gets verified.

### Tests

Why the tests that pin these decisions are built the way they are.

#### `src/__tests__/e2e/clone-sparse-initial-checkout.e2e.test.ts`

- **clone-mode initial clone with sparseCheckout**: With sparseCheckout set, the clone-mode initial clone must only produce the paths the cone keeps, each exactly once; a full checkout narrowed afterwards writes (and with LFS downloads) everything first. The e2e test uses a logging smudge filter as a stand-in for git-lfs downloads.
- **clone-mode initial clone with sparseCheckout**: git's cone-mode sparse checkout always keeps top-level files, so a root file is materialized even when only a subdirectory is in the cone.

#### `src/__tests__/e2e/clone-sparse-reapply.e2e.test.ts`

- **clone-mode sparse-checkout re-apply**: As README promises, a clone-mode sparse update that drops paths out of the cone first checks the worktree is clean, matching worktree mode, instead of narrowing and leaving git's 'left despite sparse patterns' warning. A sparse config git rejects is recorded as a run failure (exit 1) rather than a per-tick warning with exit 0.
- **clone-mode sparse-checkout re-apply**: In clone mode a failed or deferred sparse-checkout re-apply never blocks the fast-forward the sync exists for; the e2e helper pushes a commit reachable only by fast-forward to prove it.
- **clone-mode sparse-checkout re-apply**: Whether a cone entry such as 'pkg/a.txt' is a directory is a fact about the index, not the pattern, so the config loader's cone-rule check cannot reject it; git fails `sparse-checkout set` with 'is not a directory' and leaves the on-disk pattern list unchanged, which the sync reports as a failure.
- **clone-mode sparse-checkout re-apply outcome**: A clone-mode sparse re-apply is recorded in the sync outcome as an 'updated' action with reason sparse_checkout, matching what worktree mode and the clone-mode dry run already report.

#### `src/__tests__/e2e/incomplete-clone-checkout.e2e.test.ts`

- **clone-mode incomplete checkout handling**: When an LFS object cannot be served, `git clone` transfers objects but the checkout dies ('smudge filter lfs failed', exit 128, 'Clone succeeded, but checkout failed'), leaving a complete .git next to a half-written tree indistinguishable from a user's clone. Adopting it made every later sync soft-skip at info level with exit 0, so clone mode records the failed checkout and refuses to adopt such a clone, failing the run instead.
- **clone-mode sparse-checkout git client**: With skipLfs, every git client including the sparse-checkout one must carry GIT_LFS_SKIP_SMUDGE; a sparse-checkout client built with no environment made repositories that asked to skip LFS fail at the sparse step.
- **clone-mode LFS checkout recovery**: `git sparse-checkout set` materializes everything the cone brings in and runs the smudge filter like a checkout, so after an LFS-disabled checkout retry the sparse step must use the same environment; otherwise it dies on the skipped objects and leaves a narrowed tree that git status reports clean.
- **clone-mode LFS checkout recovery**: After retrying a failed clone checkout with LFS smudging disabled, the output states the tree was checked out with LFS smudging disabled, so the user knows it holds pointer files.

#### `src/__tests__/e2e/lfs-smudge-clone-merge.e2e.test.ts`

- **clone-mode fast-forward undo**: When the checkout inside `merge --ff-only` dies on an LFS smudge, git stops at the first path it cannot produce, with earlier-sorting paths already written and HEAD and index still on the old commit. Left alone, the stray files made every later tick soft-skip as dirty with exit 0, and even a repaired LFS server could not recover because git refuses to overwrite those untracked files, so clone mode undoes the half-applied fast-forward and fails the run.
- **clone-mode fast-forward undo**: The fast-forward undo must prove every written path without one batch `hash-object` failure disqualifying the rest; a dangling symlink used to fail the batch and leave every path unproved.
- **clone-mode LFS retry policy**: After a merge dies on an LFS smudge, the retry policy disables smudging and the retry's merge must actually run with GIT_LFS_SKIP_SMUDGE=1, so a filter that honours the skip lets the fast-forward succeed with pointer files.
- **clone-mode fast-forward undo**: Under rename detection a rename lists only its new name, so the fast-forward undo must separately restore the old path that the half-applied merge deleted.
- **clone-mode fast-forward undo**: The half-applied fast-forward cleanup only weighs paths the merge itself would have written, so a clone with the user's own changes still skips as dirty_tree.

#### `src/__tests__/integration/fast-forward-undo-type-change.test.ts`

- **clone-mode fast-forward undo**: A rejected `merge --ff-only` can write a tracked-file-to-symlink type change, which git status reports as ` T`, a code simple-git puts only in status.files and in none of not_added/modified/deleted. The fast-forward undo reads status.files so it sees such paths; reading the bucket lists left the checkout dirty for every later tick.

#### `src/__tests__/integration/lfs-smudge-worktree-create.test.ts`

- **worktree creation LFS fallback**: A fake filter.lfs smudge driver with filter.lfs.required reproduces a broken LFS setup, which fails `git worktree add` with 'smudge filter lfs failed'. Fetching into the bare repository never runs the smudge filter, so the fetch-side LFS fallback cannot catch it; worktree creation needs its own LFS-free retry or the create fails again on every tick.
- **WorktreeModeSyncRunner LFS skip**: Skipping LFS smudge after a failed worktree checkout is temporary: it applies to the failing sync only, and the next sync starts with LFS downloads enabled again.
- **LFS availability check**: On a machine without git-lfs and no filter configured, checkout copies pointer files through and that is not a failure. Detecting it warrants at most one warning per process, never one per created worktree, and never a wait for files, since they cannot change after `git worktree add` returns.

#### `src/__tests__/integration/lfs-smudge-worktree-update.test.ts`

- **worktree update LFS fallback**: The checkout inside `git merge --ff-only`, and inside a widening `git sparse-checkout set`, runs the LFS smudge filter just like worktree creation. Without an LFS-free fallback in the update phase the branch fails with update_failed on every tick, and files git wrote before the failing path leave the worktree dirty so later ticks skip it as dirty_worktree.

#### `src/__tests__/integration/sparse-reconcile.test.ts`

- **worktree-mode sparse reconcile**: Worktree-mode sparse-checkout reconcile must apply a cone/no-cone mode switch to existing worktrees even when the include list is unchanged, and must unquote directories git C-quotes in `sparse-checkout list` so they are not re-applied on every sync.

#### `src/services/__tests__/clone-sync.client-timeouts.test.ts`

- **CloneSyncService git clients**: Every time clone mode builds a git client it reads GitService.isLfsSkipEnabled, because the per-sync LFS skip override is layered onto the clone-mode client environment. Test doubles of GitService must therefore provide isLfsSkipEnabled.

#### `src/services/__tests__/clone-sync.service.test.ts`

- **retrySparseCheckoutWithLfsSkipped**: `git sparse-checkout set` materializes everything the cone brings in and therefore runs the LFS smudge filter. After a clone recovered by retrying checkout with smudging disabled, sparse setup must also use a client with smudging off; with the default client it would fail on the skipped objects and leave a half-narrowed tree.
- **CloneSyncService sparse update**: The README promises that the tool checks the working tree is clean before dropping paths out of the sparse cone. Clone mode, like worktree mode, therefore skips a narrowing sparse-checkout update while the tree is dirty instead of narrowing and leaving git to warn.
- **CloneSyncService sparse update**: A sparse-checkout re-apply that git rejects is recorded as a failed action in the sync outcome rather than only logged as a warning, so anything watching the run learns the config is broken.
- **CloneSyncService sparse update**: A failed sparse re-apply is not fatal to the tick: the fast-forward the sync exists for still runs.
- **CloneSyncService.upstreamOutsideSparse**: Skipping an update because all upstream changes are outside the sparse set is informational, matching worktree mode, and is not recorded as a clone-mode skip.
- **CloneGitClients**: The sync retry policy disables LFS downloads between attempts by setting an override on GitService. Clone-mode git clients must read that override (not only config.skipLfs) when they are built, otherwise the retry's merge runs with the same environment and fails on the same LFS object.
- **CloneGitClients**: Once the LFS skip override is set, every clone-mode client built in that attempt uses GIT_LFS_SKIP_SMUDGE=1, including the fetch client, because the retry's fetch runs in the same attempt as its merge.

#### `src/services/__tests__/config-loader.service.test.ts`

- **sparseCheckout schema**: Cone mode is the default sparse-checkout mode and git refuses a leading slash or a glob in cone patterns. Without load-time validation such configs loaded and then failed once per worktree per tick with a message naming neither the entry nor the rule, so cone-mode include entries are validated when the config loads.
- **sparseCheckout schema**: defaults.sparseCheckout is inherited by every repository including clone-mode ones, and clone mode runs the same `sparse-checkout set --cone`, so cone validation applies to inherited sparse settings on clone-mode repositories too.
- **sparseCheckout schema**: The update phase reads skipUpdateWhenOutsideSparse as `!== false`, so a non-boolean such as the string "false" would enable the skipping it was meant to disable and HEAD would stop advancing for changes outside the sparse set; the field must be a real boolean.

#### `src/services/__tests__/lfs-verification.service.test.ts`

- **LfsVerificationService**: git worktree add returns only after its checkout, including git-lfs delayed checkout and the post-checkout hook, has finished, so a pointer file found afterwards stays a pointer. LFS verification warns once and never sleeps; the former wait cost up to 30s per worktree without changing the result.
- **LfsVerificationService**: When GIT_LFS_SKIP_SMUDGE is exported by the user's shell or CI, pointer files are the expected checkout result, so LFS verification is skipped and nothing is warned.
- **LfsVerificationService**: git lfs ls-files walks the whole index and spawns git-lfs, so it is run only when HEAD's .gitattributes declares filter=lfs; a repository without that never had LFS content to check.
- **LfsVerificationService**: Whether git-lfs is installed is a machine-wide fact, so the probe and its warning are latched once per process rather than repeated for every created worktree.
- **LfsVerificationService**: The LFS-attribute verdict is cached by the tree oid HEAD points at, so the cache can never be stale and a second branch at the same tree does not re-run the probe.

#### `src/services/__tests__/sparse-checkout.service.test.ts`

- **SparseCheckoutService.buildPatterns**: Cone includes are sorted by UTF-8 bytes as git sorts them, not by JavaScript's UTF-16 code units; the two disagree for characters such as U+E000 versus U+1D400, which would otherwise make the comparison with git's list differ.
- **SparseCheckoutService.applyToWorktree**: Patterns are passed to git sparse-checkout set after --, because without it git reads a dash-leading directory as an option: git 2.43 tolerated -apps, 2.55 dies with 'unknown switch', and both read a directory named --skip-checks as the flag and silently set no patterns.
- **SparseCheckoutService.pathsTouchSparse**: git's cone mode also checks out files directly inside each ancestor of a nested include (include tools/build materializes files in tools/), so pathsTouchSparse treats those files as inside the sparse set.
- **SparseCheckoutService.pathsTouchSparse**: git materializes the directory an include containing '..' resolves to, so an update touching that directory must not be skipped as outside the sparse paths.
- **SparseCheckoutService.pathsTouchSparse**: git normalizes include forms like 'apps//', './apps' and 'apps/./web', so the files really are in the worktree and pathsTouchSparse normalizes the same way so updates touching them still run.
- **findConeRuleViolations**: findConeRuleViolations mirrors what real git sparse-checkout set --cone accepts and refuses; its expectations were verified against git 2.43.0 and 2.55.0, which behave identically.
- **findConeRuleViolations**: git accepts '.' as a cone include but sparse-checkout list then prints nothing, so it could never compare equal and would be re-applied every sync; a lone '.' is therefore rejected in cone mode.

#### `src/services/__tests__/worktree-creation.sparse-checkout.test.ts`

- **WorktreeCreationService.applySparseAndCheckout**: A --no-checkout worktree has no index or files yet, so moving a behind local branch to origin's tip uses reset --soft rather than merge --ff-only; the checkout after sparse setup then populates the files.

#### `src/services/__tests__/worktree-mode-sync-runner.lfs.test.ts`

- **WorktreeModeSyncRunner create phase**: Git LFS failures surface at git worktree add, whose checkout runs the smudge filter, never at the fetch into the bare repo. The runner therefore retries a create that failed with an LFS error once with GIT_LFS_SKIP_SMUDGE=1 instead of recording create_failed on every tick.
- **SyncRetryPolicy.resetLfsSkipIfNeeded**: Once enabled by the LFS fallback, the skip flag stays on for the rest of the sync; WorktreeSyncService turns it back off through resetLfsSkipIfNeeded in its finally block.
- **WorktreeModeSyncRunner LFS fallback**: The LFS skip is a GitService-wide switch, so several branches failing with LFS errors at once must enable it once, with a single warning and action, not once per branch.

#### `src/services/__tests__/worktree-sync.service.test.ts`

- **CloneSyncService git clients**: Clone mode reads isLfsSkipEnabled back on every git client it builds, so the per-sync LFS fallback also reaches its fetch and merge.
- **SyncRetryPolicy LFS handler**: A fetch never runs the smudge filter, but an LFS-shaped fetch error still reaches the retry policy's LFS handler, which enables the LFS skip for the next attempt; it never falls back to fetching branch by branch.
- **WorktreeModeSyncRunner LFS fallback**: The LFS smudge filter runs at checkout, so the LFS-skip fallback engages from the worktree create phase, and the skip it enables must be restored when the sync ends.
- **SparseCheckoutService.isNarrowing**: git echoes a cone include written as apps/ back as apps, so the trailing-slash test wires in the real sparse pattern helpers; mocked helpers would hide a mismatch.

#### `src/utils/__tests__/git-lfs-probe.test.ts`

- **isGitLfsInstalled**: A git client can throw synchronously instead of returning a rejected promise (for example when its directory vanished); isGitLfsInstalled must treat that as not installed rather than leaving the cached probe unanswered for the rest of the process.
- **isLfsSmudgeSkippedByEnv**: git-lfs does not trim GIT_LFS_SKIP_SMUDGE, so a padded value such as " 1 " still smudges and must keep LFS verification.

## Consequences

Changing code covered by an entry here means updating the entry in the same pull request. An entry that no longer holds is deleted, or superseded by a new numbered ADR when the reversal is itself a decision worth keeping.
