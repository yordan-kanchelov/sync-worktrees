# Code Review Findings — 2026-07-07

Full-codebase review (bugs + design issues). Each finding is written as a self-contained
task spec: an agent should be able to implement it from this document alone, without the
original review conversation.

Conventions used below:

- **Location** — primary files/lines (line numbers as of commit `59b897d`).
- **Current behavior** — what the code does today, with the failure scenario.
- **Expected behavior** — the spec to implement.
- **Acceptance** — how to verify (tests to add/adjust). All existing tests must keep passing;
  run `pnpm lint && pnpm typecheck && pnpm test`.

Status legend: `[ ]` open · `[x]` done · `[~]` needs product decision first.

---

## High severity

### [x] F1. Orphan cleanup can destroy the bare repo when `bareRepoDir` is inside `worktreeDir`

- **Severity**: High (permanent data loss: shared object DB + all unpushed commits)
- **Location**: `src/services/worktree-mode-sync-runner.ts:878` (`cleanupOrphanedDirectories`),
  `src/services/config-loader.service.ts:577-583` (bareRepoDir resolution — no containment check)
- **Current behavior**: `cleanupOrphanedDirectories` treats every non-dot, non-worktree
  directory directly under `worktreeDir` as an orphan and trashes/deletes it. Nothing
  validates that `bareRepoDir` lies outside `worktreeDir`. A config with
  `bareRepoDir: "./worktrees/repo-bare"` (any non-dot name inside `worktreeDir`) has its
  bare repository removed on the next sync: a bare repo has no `.git` entry, so the
  live-checkout quarantine guard does not fire. With trash disabled this is `fs.rm -rf` of
  the entire object database; with trash enabled it's recoverable but still breaks every
  worktree (their `.git` files point into the moved bare repo).
- **Expected behavior**:
  1. Config validation (`ConfigLoaderService`) rejects any worktree-mode repository whose
     resolved `bareRepoDir` is equal to or inside the resolved `worktreeDir`, and vice versa
     (worktreeDir inside bareRepoDir), with a clear `ConfigError` naming both paths.
     Use the existing case-folding path comparison (`src/utils/path-compare.ts` /
     `normalizePathForCompare`) so macOS/Windows case-insensitivity is handled.
  2. Defense in depth: `cleanupOrphanedDirectories` additionally skips (with a warning) any
     candidate directory whose resolved path equals the configured `bareRepoDir`
     (`gitService.getBareRepoPath()`), regardless of validation.
- **Acceptance**: unit test in config-loader tests: config with `bareRepoDir` inside
  `worktreeDir` throws at load; test for the reverse nesting; runner test: a directory that
  matches the bare repo path is never passed to trash/rm even if unregistered.

### [x] F2. `filesToCopyOnBranchCreate` is functionally broken (absolute-path glob mangling)

- **Severity**: High (documented feature silently does nothing / errors per file)
- **Location**: `src/services/config-loader.service.ts:624` (patterns resolved to absolute
  paths), `src/services/file-copy.service.ts:43-44` (`path.join(sourceDir, relativePath)`)
- **Current behavior**: the loader maps every pattern through
  `this.resolvePath(f, configDir)`, producing absolute patterns. `glob` ignores `cwd` for
  absolute patterns and returns absolute matches. `FileCopyService` then joins that
  absolute match onto `sourceDir`, producing paths like `/cfg/cfg/.env` → ENOENT for every
  file; destination paths would be wrong even when the join accidentally resolves.
  (Verified experimentally: `glob('/etc/hosts', {cwd:'/etc'})` → `['/etc/hosts']`.)
- **Expected behavior**: patterns stay **relative** end-to-end. The loader must NOT
  path-resolve `filesToCopyOnBranchCreate` entries; `FileCopyService` globs them relative
  to `sourceDir` (`cwd: sourceDir`) and copies each relative match `sourceDir/<rel>` →
  `worktreePath/<rel>`. Reject (or warn and skip) absolute patterns and patterns escaping
  `sourceDir` (`..`) — file copy must never read or write outside `sourceDir`/`worktreePath`.
- **Acceptance**: integration-style test with a temp config dir containing `.env` and a
  nested `config/local.json`: after the copy step both exist inside the target worktree at
  the same relative paths. Test that an absolute pattern and a `../escape` pattern are
  rejected/skipped with a warning. Verify both call sites: clone-mode initial copy
  (`clone-sync.service.ts:745`, `runInitialFileCopy`) and the TUI/hook branch-created path
  (`branch-created-actions.service.ts`).

### [x] F3. MCP `update_worktree` (and `create_worktree`) act on stale refs — no fetch

- **Severity**: High (reports success while doing nothing / creates divergent branches)
- **Location**: `src/mcp/handlers.ts:447-472` (`update_worktree`), `handlers.ts:363-399`
  (`create_worktree`), `src/services/git.service.ts:1105-1127` (`updateWorktree` — merge
  only, no fetch), `git.service.ts:1297-1315` (`branchExists` — local refs only)
- **Current behavior**: the only fetch in the MCP path happens inside `initialize()` on the
  *first* call per service instance. In a long-lived MCP session, `update_worktree` then
  runs `merge origin/<branch> --ff-only` against a stale remote-tracking ref, no-ops, and
  returns `{success: true, updated: true?}` while the worktree is behind the real remote.
  `create_worktree` decides "branch is new" from stale local `refs/remotes/origin/*`; if a
  teammate pushed the branch after the last fetch and `baseBranch` is supplied (the tool
  description recommends it), it creates a **divergent duplicate** branch from
  `baseBranch`, then `pushBranch` fails non-fast-forward, and the handler reports pure
  failure with the half-created worktree left behind (see F13 for the reporting half).
- **Expected behavior**:
  1. `update_worktree` fetches the target branch before merging: `fetchBranch(branch)`
     (worktree mode) prior to `updateWorktree`. Failure to fetch is a reported error, not a
     silent stale success.
  2. `create_worktree` fetches (at minimum `fetchBranch(branchName)` tolerating
     missing-ref, or a full `fetchAll`) before calling `branchExists`, so the
     local/remote existence matrix reflects the actual remote.
  3. Both still run inside `runExclusiveRepoOperation` as today.
- **Acceptance**: handler tests with a mocked GitService asserting fetch is called before
  merge/branch-matrix; a test that a remote-updated branch results in an actual update
  (mock `fetchBranch` mutating the mocked ref state).

### [x] F4. Worktree-mode default-branch detection breaks on branch names containing `/`

- **Severity**: High for affected repos (initialization fails outright)
- **Location**: `src/services/git.service.ts:1033-1068` (`detectDefaultBranch`)
- **Current behavior**: `headRef.trim().split("/").pop()` turns
  `refs/remotes/origin/release/2024` into `2024`. Initialization then attempts
  `worktree add --track -b 2024 origin/2024`, which fails (`origin/2024` doesn't exist) and
  aborts init. The clone-mode equivalent `getRemoteDefaultBranch` (`git.service.ts:247-294`)
  parses correctly with a regex on `refs/heads/(...)`.
- **Expected behavior**: strip only the known prefix: branch =
  `headRef.trim().replace(/^refs\/remotes\/origin\//, "")` (both in the primary
  `symbolic-ref` path and the post-`remote set-head` retry). Everything downstream
  (`mainWorktreePath = path.join(worktreeDir, defaultBranch)`) already handles nested
  paths — `cleanupOrphanedDirectories` matches via `startsWith(dir + path.sep)`.
- **Acceptance**: unit test: `detectDefaultBranch` (or an extracted pure parser) returns
  `release/2024` for `refs/remotes/origin/release/2024\n`; e2e-style test optional.

---

## Medium severity

### [x] F5. Stashed changes are silently lost in the diverged-replace flow

- **Severity**: Medium (data loss; requires diverged history + stash combo)
- **Location**: `src/services/worktree-mode-sync-runner.ts:684-761` (Phase 4a gate),
  `:960-1036` (`handleDivergedBranch`), `src/services/trash.service.ts:130-207` (pin covers
  HEAD only)
- **Current behavior**: the prune path blocks removal when `hasStashedChanges` is true, but
  the update path's eligibility gate only checks `hasOperationInProgress` +
  `checkWorktreeStatus` (uncommitted changes). A diverged worktree **with a stash** goes
  through diverged-replace: payload directory is preserved, but
  `removeWorktree(..., {force: true})` deletes the per-worktree admin dir including its
  stash ref. The trash pin ref only pins `headOid`, so stash commits become unreachable and
  are collected by gc (immediately under `maintenance.aggressive` → `gc --prune=now`).
- **Expected behavior**: the diverged-replace path (both branches of `handleDivergedBranch`
  that end in worktree removal/reset — specifically the "has local changes → move aside"
  branch) must first check `hasStashedChanges(worktreePath)`. If stashed changes exist,
  skip the replace: log a warning telling the user to pop/apply or drop the stash, record
  `outcome.recordSkipped("worktree", "stash_present", …)`, and leave the worktree
  untouched. (Alternative — pinning each stash commit alongside the HEAD pin — is
  acceptable but larger; skipping is the minimal safe spec.)
- **Acceptance**: runner test: diverged worktree with a mocked stash count > 0 is not moved
  to .diverged/trash, not removed, and shows up as skipped in the outcome; diverged
  worktree without stash behaves as before.

### [x] F6. runOnce exit-code masking (soft-skip hides hard failure; SIGINT exits 0; per-repo `runOnce` dead)

- **Severity**: Medium (CI sees success on failed/aborted runs)
- **Location**: `src/index.ts:152-158` (failedCount filter), `src/index.ts:40,189` +
  `src/utils/signal-handlers.ts:43-46` (signal path), `src/index.ts:50` +
  `src/services/config-loader.service.ts:560` (per-repo runOnce resolved but unused)
- **Current behavior** (three related defects):
  1. `failedCount` excludes any rejected repo whose name appears in `skippedNames`
     (populated from `getRecordedSkips()` regardless of final outcome). A repo that records
     a clone-mode soft skip during init and then hard-fails (e.g. network error) is counted
     as "skipped" → `process.exitCode` stays 0.
  2. Cleanup functions are only registered in the daemon branch, so SIGINT/SIGTERM during a
     runOnce sync resolves `Promise.allSettled([])` immediately and exits **0** mid-sync.
  3. Per-repository `runOnce: true` is validated and resolved by the loader but never read:
     only `configFile.defaults?.runOnce` selects the mode, so the documented per-repo
     override does nothing.
- **Expected behavior**:
  1. A rejected sync always increments `failedCount` (exit code 1), independent of any
     soft skips it recorded earlier. Soft skips only suppress failure when the run
     *completed* without throwing.
  2. In runOnce mode, first SIGINT/SIGTERM exits with a non-zero code (130 conventional)
     after best-effort abort; the "second signal / watchdog" behavior stays as is.
  3. Decide the semantics of per-repo `runOnce` and implement one of: (a) honor it — a repo
     with `runOnce: true` syncs once while others stay scheduled (mode is then per-repo,
     not global), or (b) remove it from the per-repo schema and document `runOnce` as
     defaults-only. Option (b) is the smaller, less surprising change; pick it unless the
     maintainer says otherwise.
- **Acceptance**: test: repo records skip then `sync()` rejects → exit code 1. Test (or
  manual verification note) for signal exit code in runOnce. For (3b): per-repo `runOnce`
  rejected by validation with a pointer to `defaults.runOnce`.

### [x] F7. Trash reaper can delete another config's live pin refs (shared `bareRepoDir`)

- **Severity**: Medium (silent data loss; requires two configs sharing a bare repo)
- **Location**: `src/services/trash-reaper.service.ts:190-204` (orphaned-pin sweep)
- **Current behavior**: the sweep deletes any `refs/sync-worktrees/trash/<id>` whose `<id>`
  has no matching container under *this config's* trash root. Two config files pointing at
  the same `bareRepoDir` with different `worktreeDir`s (the duplicate-bareRepoDir check is
  per-file and cannot see across configs) each store trash containers in their own
  `.trash/` — so config A's reaper sees config B's pin ids as orphans and deletes them,
  making B's trashed unpushed commits gc-eligible.
- **Expected behavior**: pin refs must be attributable to their trash root. Spec: include a
  stable trash-root discriminator in the ref name (e.g.
  `refs/sync-worktrees/trash/<rootHash>/<id>`, `rootHash` = first 16 hex of sha256 of the
  canonical trash-root path — same recipe as `lock-path.ts`), and the sweep only considers
  refs under its own `<rootHash>/` namespace. Migration: refs in the old flat namespace are
  left untouched by the sweep (warn once), and the existing trash-migration service may
  adopt them. Restore/reap must resolve both layouts during the transition.
- **Acceptance**: reaper test: refs under a foreign rootHash namespace (and legacy flat
  refs) survive the sweep; own-namespace refs without containers are still cleaned.

### [x] F8. MCP repo-selection state machine: stuck auto-detect entry, silent first-repo pin, stale `discovered`

- **Severity**: Medium (wrong-target operations, permanent bogus errors in a session)
- **Location**: `src/mcp/context.ts:217-223` (loadConfig currentRepo handling), `:368`
  (`bootstrapCurrentRepo` early-return), `:268-270` (`invalidateDiscovered`),
  `src/mcp/handlers.ts:45-52,114-118` (readers of `entry.discovered`)
- **Current behavior** (three related defects):
  1. Server starts in auto-detect mode → `currentRepo = "__auto_detected__:…"` with
     `sync` capability unavailable. A later `load_config` keeps that entry in the map, so
     `currentRepo` survives, and `sync` fails forever with "no config file loaded" even
     though it is.
  2. `load_config` pins `currentRepo` to `repositories[0]` whenever nothing is selected —
     bypassing the designed ambiguity error (`selectDefaultRepository`), so repo-scoped
     tools silently target repo A while the user works in repo B.
  3. `invalidateDiscovered()` clears only `discoveryCache`, never `entry.discovered`;
     capability checks and worktree-membership validation keep reading pre-mutation state
     (e.g. a worktree removed by `sync` still passes membership and produces a raw git
     error).
- **Expected behavior**:
  1. After `load_config`, if `currentRepo` points at a *detected* pseudo-entry whose path
     is now covered by a configured repository, reselect: switch `currentRepo` to that
     configured repo (path match via the existing discovery machinery).
  2. `load_config` must not auto-pin `repositories[0]` when the config has >1 repository
     and no unambiguous match with the CWD — leave `currentRepo` null so the existing
     ambiguity error/selection flow triggers. Auto-pin remains OK for single-repo configs.
  3. `invalidateDiscovered()` also nulls `entry.discovered` for the affected repo(s) so the
     next capability/membership read re-discovers.
- **Acceptance**: context tests covering all three transitions (start-detected →
  load_config → sync succeeds; multi-repo load_config leaves selection empty; post-sync
  membership check re-discovers instead of reading stale lists).

### [x] F9. Config validation gaps + `.cjs` reload staleness + local-path `repoUrl` contradiction

- **Severity**: Medium (invalid configs accepted → runtime crashes; stale config in daemons)
- **Location**: `src/services/config-loader.service.ts:91-168` (validation), `:56`
  (import cache-buster), `:690` + `src/utils/git-url.ts:7-47` (URL validation vs
  `extractRepoNameFromUrl`), `:363-367` (parallelism validation)
- **Current behavior**:
  1. `branchInclude`/`branchExclude` accept non-arrays (`branchInclude: "main"` crashes
     mid-sync with `include.some is not a function`); `branchMaxAge: "14 days"` passes and
     silently disables the age filter; `skipLfs`/`updateExistingWorktrees` types unchecked;
     parallelism fields accept non-integers (`pLimit(1.5)` throws at runtime).
  2. The `?t=` query cache-buster does not bust the CJS require cache — long-lived
     processes (MCP `load_config`, daemon) silently keep the first-loaded `.cjs` config
     (verified experimentally).
  3. `isValidGitUrl` accepts absolute local paths and trailing-slash URLs, but
     `extractRepoNameFromUrl` (used to default `bareRepoDir`) has no pattern for them and
     throws `Invalid Git URL format` — validator-blessed config fails with a contradictory
     error.
- **Expected behavior**:
  1. Load-time validation: `branchInclude`/`branchExclude` must be arrays of strings;
     `branchMaxAge` must match `parseDuration`'s grammar (`^\d+[hdwmy]$`) — reject, don't
     silently ignore; `skipLfs`/`updateExistingWorktrees` must be booleans; parallelism
     values must be positive **integers**. Every rejection is a `ConfigError` naming the
     repo and field.
  2. `.cjs` reload: before importing a `.cjs` config, delete its entry (and its child
     module subtree) from `require.cache` — or document + enforce that `.cjs` configs
     cannot be hot-reloaded and have `load_config` return an explicit error for a repeated
     `.cjs` load. Pick the cache-delete approach unless it proves unworkable under ESM.
  3. Either extend `extractRepoNameFromUrl` to handle plain absolute paths (basename minus
     `.git`, tolerating a trailing slash) or make validation require an explicit
     `bareRepoDir` for path-style URLs. Extending the parser is preferred (smaller user
     burden).
- **Acceptance**: loader tests for each rejected shape; a `.cjs` reload test (write file,
  load, rewrite, reload → new values); `repoUrl: "/srv/git/repo.git"` without
  `bareRepoDir` loads and resolves `bareRepoDir` to `.bare/repo`.

### [x] F10. MCP clone-mode `initialize` reports wrong `defaultBranch`

- **Severity**: Medium (misleading API output)
- **Location**: `src/mcp/handlers.ts:495`, `src/services/git.service.ts:54`
- **Current behavior**: the handler returns `git.getDefaultBranch()`, but clone-mode init
  never runs `GitService.initialize`, so it returns the constructor constant `"main"`
  regardless of the tracked branch (`develop`, etc.).
- **Expected behavior**: for clone-mode repos the handler reports the clone's resolved
  branch (`CloneSyncService.resolveBranch()` — expose it via `WorktreeSyncService` if
  needed), falling back to config `branch`. Never report the worktree-mode constant for a
  clone-mode repo.
- **Acceptance**: handler test: clone-mode repo with `branch: "develop"` →
  `initialize` response contains `defaultBranch: "develop"`.

---

## Low severity

### [x] F11. Retry util: unbounded retry of permanent errors; `NaN` maxAttempts

- **Location**: `src/utils/retry.ts:32-70`
- **Current**: default `shouldRetry` retries `ENOENT`/`EACCES` (typically permanent);
  util-level default `maxAttempts` is `"unlimited"` (product default 3 is applied only by
  `SyncRetryPolicy`); `maxAttempts: NaN` passes the `< 1` check.
- **Expected**: classify `EACCES`/`EPERM`/`EROFS`/`ENOSPC` (and plain `ENOENT`) as
  non-retryable by default; validate `maxAttempts` with `Number.isFinite` (mirroring the
  trash config validation) unless it is the literal string `"unlimited"`.
- **Acceptance**: retry unit tests for each error class and for `NaN` rejection.

### [x] F12. `timing.ts` "Efficiency" column is fake math

- **Location**: `src/utils/timing.ts:73-78`
- **Current**: `theoreticalSequentialTime = count * (duration / batches)` reduces to
  `efficiency = count/batches` — a pure function of count and configured parallelism,
  independent of measured time (6 items at parallelism 3 always prints 300%).
- **Expected**: drop the column (preferred — it cannot be computed without per-item
  timings) or compute it from real per-item durations if the PhaseTimer records them.
- **Acceptance**: timing table test updated; no misleading percentage in debug output.

### [x] F13. MCP `create_worktree` partial success reported as pure failure

- **Location**: `src/mcp/handlers.ts:385-399`
- **Current**: `addWorktree` succeeds, then `pushBranch` throws → response carries only the
  push error; retrying agents then hit unexplained "already exists".
- **Expected**: when worktree creation succeeded but push failed, the response must say so:
  structured payload with `created: true, pushed: false, pushError: <msg>` and a
  non-success status — not a bare error losing the created state.
- **Acceptance**: handler test with mocked push failure asserting the structured partial
  result.

### [x] F14. `ensurePathBelongsToRepo` misattributes infrastructure failures

- **Location**: `src/mcp/handlers.ts:120-127`
- **Current**: a thrown worktree-listing error is swallowed and reported as
  "Path '…' is not a registered worktree", blaming the caller's path.
- **Expected**: listing failure surfaces as its own error ("could not verify worktree
  membership: <cause>"), distinct from a genuine membership rejection.
- **Acceptance**: handler test with `getWorktrees` throwing.

### [x] F15. Init wizard: weak cron validation and duplicate-name generation

- **Location**: `src/utils/interactive.ts:130-138`, `src/utils/config-generator.ts`
- **Current**: cron input only needs ≥5 whitespace-separated fields (`a b c d e` accepted →
  config fails on every load); two URLs ending in the same repo name generate duplicate
  `name` fields the loader rejects. Wizard reports success; config never loads.
- **Expected**: validate cron with `node-cron`'s `validate` (already a dependency, already
  used by the loader); de-duplicate generated names (suffix `-2`, `-3`, …) or prompt.
- **Acceptance**: wizard unit tests for both.

### [x] F16. Duplicate, conflicting `isLfsError` implementations

- **Location**: `src/errors/index.ts:127-130` vs `src/utils/lfs-error.ts`
- **Current**: the errors-module version matches any message containing bare `"LFS"`
  (via `ERROR_MESSAGES.LFS_ERROR`); all runtime code uses the stricter utils version. The
  loose one is exported dead code and a misclassification landmine.
- **Expected**: delete the loose implementation (and the `ERROR_MESSAGES.LFS_ERROR`
  patterns if then unused); re-export the utils version from `errors/index.ts` only if
  external callers need it.
- **Acceptance**: typecheck + grep shows one implementation; existing LFS classification
  tests still pass.

### [x] F17. Hook timeout leaves a live 5s SIGKILL timer

- **Location**: `src/services/hook-execution.service.ts:119-127,157-163`
- **Current**: after a hook timeout, the `close` handler returns early on `timedOut` and
  never clears the SIGKILL `killTimer`; it isn't `unref`'d either, so a runOnce process
  lingers up to 5 extra seconds per timed-out hook.
- **Expected**: clear the kill timer on child exit in all paths (or `unref()` it at
  creation).
- **Acceptance**: hook execution test asserting no open timer handle after a timed-out
  hook's child exits.

### [x] F18. `verifyLfsFilesDownloaded`: sampling with replacement + long blocking poll

- **Location**: `src/services/git.service.ts:399-455`
- **Current**: samples up to 5 files **with replacement** (can check the same file 5×) and
  polls up to 30 × 1s per worktree, serially blocking the sync.
- **Expected**: sample without replacement (shuffle-take or index set); make the retry
  budget configurable and/or drastically shorter by default; consider verifying in the
  background of the create phase. Minimal spec: no-replacement sampling + extract the 30s
  constant to `DEFAULT_CONFIG` so it's tunable.
- **Acceptance**: unit test that 5 distinct files are sampled when ≥5 exist.

### [x] F19. Metadata keyed by worktree-path basename with an incorrect justifying comment

- **Location**: `src/services/worktree-metadata.service.ts:20-27`
- **Current**: metadata is stored under `<bareRepo>/.git/worktrees/<basename>/`; the
  comment claims git uses the basename as the internal admin-dir name — git actually
  de-duplicates with `-1` suffixes, and this store is a sibling directory the tool owns,
  not git's admin dir. Safe today only because hash-suffixed worktree names make basenames
  unique; a future naming change could silently collide metadata between worktrees.
- **Expected**: fix the comment to state the actual invariant ("we key by basename; unique
  because sanitizeBranchName guarantees unique basenames") and add a guard: when saving
  metadata, if an existing file's `upstreamBranch` refers to a *different* branch, warn and
  refuse to overwrite. (Full path-hash keying is out of scope unless the naming scheme
  changes.)
- **Acceptance**: unit test for the mismatch guard.

### [x] F20. `mcp-registration` treats every exit-1 as "unregistered"

- **Location**: `src/utils/mcp-registration.ts:36-38`
- **Current**: `code === 1` from `claude`/`codex` CLIs is assumed to mean "server missing";
  any other exit-1 failure (corrupt config, auth) triggers a registration prompt and an
  `mcp add` that may duplicate/overwrite.
- **Expected**: additionally match the CLI's "not found"-style stderr/stdout before
  concluding "unregistered"; on unrecognized exit-1 output, report "could not determine
  registration state" and do nothing.
- **Acceptance**: unit test with a fake CLI emitting an unrelated exit-1 error → no
  registration attempt.

---

## Needs product decision (do not implement without maintainer sign-off)

### [~] D1. Hash suffix on every worktree directory name vs docs

- **Location**: `src/services/path-resolution.service.ts:11-18` (`sanitizeBranchName`),
  README / CLAUDE.md examples showing `worktrees/main/`, `feature-1/`
- **Tension**: since PR #54, every branch worktree directory is `<stem>-<8-hex-hash>`
  (e.g. `feature-x-a1b2c3d4/`) — collision-proof, but user-facing directory names people
  cd into, and the docs still show plain names. Options:
  - (a) Keep always-hash; update README/CLAUDE.md examples to match reality.
  - (b) Hash only when needed (name contains `/` or other substituted chars, or a
    collision with an existing reserved path is detected by the planner). Prettier names;
    requires care in `extractBranchFromWorktreePath`/metadata keying (see F19) and a
    migration story for existing hashed dirs.
- **Decision needed**: (a) or (b). Note F19's metadata-uniqueness guard becomes mandatory
  under (b).

### [~] D2. `GitService` decomposition

- **Location**: `src/services/git.service.ts` (1372 lines)
- **Observation**: mixes clone/init orchestration, the worktree-add matrix with three
  near-identical rollback blocks (`addWorktree`, ~200 lines), LFS verification, metadata
  delegation, and ~30 thin git wrappers. The extracted services (status, path, sparse) show
  the intended shape. Suggested cut if approved: extract `WorktreeCreationService`
  (add-matrix + rollback + metadata) and `LfsVerificationService`; keep `GitService` as the
  thin git/porcelain wrapper. Pure refactor, no behavior change, high test-churn — needs
  maintainer appetite before anyone starts.

---

## Suggested task batching for agents

- **Batch 1 (independent, small, high value)**: F1, F2, F4, F16, F17 — no cross-coupling.
- **Batch 2 (CLI/runOnce semantics)**: F6 (+F11, F12, F15 nearby).
- **Batch 3 (MCP layer)**: F3, F8, F10, F13, F14, F20 — same files, do as one series.
- **Batch 4 (config loader)**: F9 — one file, several validations.
- **Batch 5 (safety subsystems, review carefully)**: F5, F7, F18, F19 — touch the
  removal/trash paths; require the most careful tests.
- D1/D2 blocked on maintainer decision.
