# Follow-ups

404 items found while implementing the [6.0.0 review](6.0.0-review.md) (T1–T121) and deliberately left
out of scope at the time. None of them is a regression from that work: they are pre-existing
behaviour, latent hazards, test gaps, and notes that would have widened a cluster's diff beyond
the item it was implementing.

This file is the record so they are not lost. It is **not** a queue — nothing here has been
triaged, prioritised or sized, and some entries have since been overtaken by later items on the
same branch. Re-verify any entry before acting on it; roughly a sixth of the original audit's
items turned out to have been fixed by an earlier item before their turn came, and the same will
be true here.

## How to read it

Entries are grouped by the item whose implementation surfaced them, in the order they were worked.
Most carry a `file:line` citation and the reasoning behind the call to defer.

The formatting is not uniform, because these were written by different reviewers across the run:
some entries are prefixed with an `FU-` identifier, some are keyed by their source item
(`T51:`), and some are plain prose bullets under their section heading. The content was kept
verbatim rather than normalised, since rewriting 400 entries would risk losing the precision that
makes them worth keeping.

## Worth pulling out

One standing security item, which is the only entry here flagged as such:

- **`bin/sync-worktrees.js` does not redact credential-bearing URLs.** The library redacts
  them across logs, errors and MCP responses; the launcher script does not.
- Two further places where URL redaction has drifted on the way to the terminal interface
  (`FU-T44-3`, `FU-T108-1`). Nothing enforces that a URL reaching the interface has been
  through a redaction helper, and the codebase has now drifted here three times.

## Sections

- [From T81 review (not a TODO.md item)](#from-t81-review-not-a-todomd-item)
- [From T64 review (not a TODO.md item)](#from-t64-review-not-a-todomd-item)
- [From T2 review (not a TODO.md item)](#from-t2-review-not-a-todomd-item)
- [From T55 review (not a TODO.md items)](#from-t55-review-not-a-todomd-items)
- [From T56 review (not TODO.md items)](#from-t56-review-not-todomd-items)
- [From T57 review (not a TODO.md item)](#from-t57-review-not-a-todomd-item)
- [From T58 review (not TODO.md items)](#from-t58-review-not-todomd-items)
- [From T60 review (not a TODO.md item)](#from-t60-review-not-a-todomd-item)
- [From T12 review (not TODO.md items)](#from-t12-review-not-todomd-items)
- [From T13 review (not TODO.md items)](#from-t13-review-not-todomd-items)
- [From T14 review (not TODO.md items)](#from-t14-review-not-todomd-items)
- [From T15 (not TODO.md items)](#from-t15-not-todomd-items)
- [From T16 (not TODO.md items)](#from-t16-not-todomd-items)
- [From T72 review (not TODO.md items)](#from-t72-review-not-todomd-items)
- [From T73 (not TODO.md items)](#from-t73-not-todomd-items)
- [From T67 (not TODO.md items)](#from-t67-not-todomd-items)
- [T68 (clone-mode sparse narrowing) — remaining nits](#t68-clone-mode-sparse-narrowing-remaining-nits)
- [T66 (shallow clone depth ratchet) — remaining nits](#t66-shallow-clone-depth-ratchet-remaining-nits)
- [T71 (clone tick classifies before scanning) — remaining nits](#t71-clone-tick-classifies-before-scanning-remaining-nits)
- [T74 (converge remote config on drift) — remaining nits](#t74-converge-remote-config-on-drift-remaining-nits)
- [T75 (batched stale-ref sweep) — remaining nits](#t75-batched-stale-ref-sweep-remaining-nits)
- [Repo hygiene — apply directly, not via a task loop](#repo-hygiene-apply-directly-not-via-a-task-loop)
- [T76 (clone-mode phase timing) — remaining nits](#t76-clone-mode-phase-timing-remaining-nits)
- [T65 (strip repository-selection env vars) — remaining nits](#t65-strip-repository-selection-env-vars-remaining-nits)
- [T69 (file copy stays out of sibling checkouts) — notes](#t69-file-copy-stays-out-of-sibling-checkouts-notes)
- [T70 (partial-clone cleanup tests) — a real hole found, NOT fixed](#t70-partial-clone-cleanup-tests-a-real-hole-found-not-fixed)
- [T26 (legacy flat trash pin refs) — remaining notes](#t26-legacy-flat-trash-pin-refs-remaining-notes)
- [T27 (trash delete ordering) — remaining notes](#t27-trash-delete-ordering-remaining-notes)
- [T28 (force clean binds to what it showed) — remaining notes](#t28-force-clean-binds-to-what-it-showed-remaining-notes)
- [T11 (verbatim symlinks in preservation copies) — remaining notes](#t11-verbatim-symlinks-in-preservation-copies-remaining-notes)
- [T7 — trash sizing (leftover, not done)](#t7-trash-sizing-leftover-not-done)
- [T82 — branch config sections (leftovers, not done)](#t82-branch-config-sections-leftovers-not-done)
- [T83 — adopted .diverged keep refs (leftovers, not done)](#t83-adopted-diverged-keep-refs-leftovers-not-done)
- [T84 — force-clean gc (leftovers, not done)](#t84-force-clean-gc-leftovers-not-done)
- [T85 — manifest ref arguments (leftovers, not done)](#t85-manifest-ref-arguments-leftovers-not-done)
- [T86 — keep refs (leftovers, not done)](#t86-keep-refs-leftovers-not-done)
- [T87 — restore by rename (leftovers, not done)](#t87-restore-by-rename-leftovers-not-done)
- [T89 — trash CLI (leftovers, not done)](#t89-trash-cli-leftovers-not-done)
- [T90 — real-git trash coverage (leftovers, not done)](#t90-real-git-trash-coverage-leftovers-not-done)
- [Environment note for this sandbox (not a repo issue)](#environment-note-for-this-sandbox-not-a-repo-issue)
- [Coordinator note (Batch 5 ordering) — T31 vs T33](#coordinator-note-batch-5-ordering-t31-vs-t33)
- [T31 follow-ups (from the adversarial review)](#t31-follow-ups-from-the-adversarial-review)
- [FU-BUILD-1 — `pnpm build` never cleans `dist/`, so stale output ships](#fu-build-1-pnpm-build-never-cleans-dist-so-stale-output-ships)
- [T33 follow-ups](#t33-follow-ups)
- [T32 follow-ups](#t32-follow-ups)
- [T34 follow-ups](#t34-follow-ups)
- [T35 follow-ups](#t35-follow-ups)
- [CORRECTION to FU-T32-5 / the "comments triple in the tarball" rule — measured definitively](#correction-to-fu-t32-5-the-comments-triple-in-the-tarball-rule-measured-definitively)
- [T91 follow-ups](#t91-follow-ups)
- [T92 follow-ups](#t92-follow-ups)
- [SECURITY — FU-BIN-1: `bin/sync-worktrees.js` does not redact secrets](#security-fu-bin-1-binsync-worktreesjs-does-not-redact-secrets)
- [T93 follow-ups](#t93-follow-ups)
- [T94 + T96 follow-ups](#t94-t96-follow-ups)
- [T95 follow-ups](#t95-follow-ups)
- [T79 follow-ups](#t79-follow-ups)
- [T80 follow-ups](#t80-follow-ups)
- [From T61 (retry docs) — reviewer, 2026-09-16](#from-t61-retry-docs-reviewer-2026-09-16)
- [From T36 (syncOnStart) — reviewer, 2026-09-16](#from-t36-synconstart-reviewer-2026-09-16)
- [Byte-budget intelligence (measured, 2026-09-16) — AFFECTS EVERY REMAINING TASK](#byte-budget-intelligence-measured-2026-09-16-affects-every-remaining-task)
- [From T39 (strict MCP tool inputs) — 2026-09-16](#from-t39-strict-mcp-tool-inputs-2026-09-16)
- [From T37 (create_worktree branch filters) — 2026-09-16](#from-t37-create_worktree-branch-filters-2026-09-16)
- [From T103 (.ts configs, Node 24 floor) — 2026-09-16](#from-t103-ts-configs-node-24-floor-2026-09-16)
- [From T97 (auto-detected worktreeDir) — 2026-09-16](#from-t97-auto-detected-worktreedir-2026-09-16)
- [*** THE COMMENT-COST RULE — DEFINITIVE. I got this wrong FOUR times. ***](#the-comment-cost-rule-definitive-i-got-this-wrong-four-times)
- [From T98 (detached-HEAD update_worktree) — 2026-09-16](#from-t98-detached-head-update_worktree-2026-09-16)
- [From T99 (broken config invisible to the agent) — 2026-09-16](#from-t99-broken-config-invisible-to-the-agent-2026-09-16)
- [From T100+T101 review (2026-09-16)](#from-t100t101-review-2026-09-16)
- [From T102 (worker + review, 2026-09-16)](#from-t102-worker-review-2026-09-16)
- [From T105 (worker + review, 2026-09-16)](#from-t105-worker-review-2026-09-16)
- [From T42+T43+T107+T117 (worker + review, 2026-09-16)](#from-t42t43t107t117-worker-review-2026-09-16)
- [From T110+T114 (worker + 5-lens review + fixer, 2026-09-16)](#from-t110t114-worker-5-lens-review-fixer-2026-09-16)
- [From T111+T112 (worker + 5-lens review + fixer, 2026-09-17)](#from-t111t112-worker-5-lens-review-fixer-2026-09-17)

---

- T51: `react-hooks/refs`, `react-hooks/set-state-in-effect`, `require-await`, `preserve-caught-error` turned off with comments; 84 auto-fixable `no-unnecessary-type-assertion` hits in tests. `.pnpmfile.cjs` gives linter packages a private typescript@6 because the repo builds with TS 7.
- T119: branch protection must reference the new check names "Lint, Type Check & Test (Node 22)" / "(Node 24)"; `release.yml` has a stale "Node 22 ships with npm 10.x" comment.
- T120: `react-devtools-core` alias in esbuild.config.js is dead under packages:"external" (also `devtools-stub.js`); `server.test.ts:182` title says "rejects a legacy handshake" but asserts it is served.
- T121: JS source maps are no longer published (product choice); `tsc --watch` emits per-module JS into dist/.
- T1: `ensureCapability` still returns when no entry exists (relies on getService throwing); a detected entry later covered by load_config stays denied under its `__auto_detected__` name.
- T40: TARGET_EXISTS wording for a detached-HEAD worktree at the path.
- T30: e2e children without XDG_STATE_HOME leave zero-byte lock files under ~/.cache/sync-worktrees/locks (pre-existing class); `clone-mode.e2e.test.ts` still passes NODE_ENV=production (redundant).
- T10: unwritable state dir logs ~4 lines per repo in --runOnce (warn at acquire + error at service, for initialize and sync); `initialize()` still swallows lock_unavailable.
- T5: simple-git's unsafe allowances only cover GIT_ASKPASS/SSH_ASKPASS/GIT_CONFIG_COUNT; PAGER, GIT_PAGER, GIT_SSH, GIT_SSH_COMMAND, GIT_CONFIG_GLOBAL/SYSTEM, GIT_CONFIG, GIT_EXEC_PATH, PREFIX, GIT_TEMPLATE_DIR, GIT_PROXY_COMMAND, GIT_EXTERNAL_DIFF in the parent env make every explicit-env client throw (pre-existing; affects fetch/checkout LFS-skip clients and clone-sync). Suggest centralizing the allowance set in src/utils/git-env.ts and widening it. MCP handlers construct WorktreeStatusService without skipLfs.
- T50: catch-all `console.error(label, err)` sites bypass the scrubbing logger (App.tsx 166/183/186/193/196/307, BranchCreationWizard.tsx:250, app-events.ts:53, disk-space.ts:74) and `process.stderr.write(err.message)` in mcp/index.ts and mcp/context.ts:257; traced as not leaking in practice but not defence-in-depth. Query-string secrets (`?token=`) are out of scope. An unescaped `@` in a password leaves the post-`@` fragment (matches git's own parsing).
- T22: daemon cron tick runs with `logErrors: false` (InteractiveUIService.tsx ~187), so init-time rejections (origin mismatch, clone failure, network) are counted in `failures` but never written to the TUI log; only manual sync/reload shows them (pre-existing; belongs with Batch 7). README/changeset say `.git` is ignored unconditionally but normalization keeps it for file:// and bare local paths.
- T21: the unchanged pre-check in initialize() still reuses a registered-but-prunable default worktree whose directory exists (broken gitfile, admin dir survives); a local-only default branch (no origin/<default>) now creates without upstream and fails at the first ff-merge instead of at init, with a misleading "push to set upstream" info line; main's creation now runs the LFS verification (warn line when git-lfs is absent).
- T49: GIT_TERMINAL_PROMPT=0 fixes the HTTPS prompt hang only; ssh reads passphrases/host-key confirmations from /dev/tty itself, so an SSH key without an agent or an unknown host key still blocks until the 300 s inactivity timeout (pre-existing). A proper fix probes `core.sshCommand` per repo (async, once at init) and wraps whichever ssh command is in effect with `-o BatchMode=yes`; injecting GIT_SSH_COMMAND was rejected because it overrides core.sshCommand. With every client now passing an explicit env, a shell exporting GIT_CONFIG_KEY_n for a key outside simple-git's allowance set (core.hooksPath, core.editor, alias.*, gpg.program, filter.*) is rejected for every git call. HTTP 403 / "requested URL returned error" is still classified retryable. The interactive CLI can no longer type credentials at a prompt (intended, documented).
- T47: `getRemovalAuditLogPath` still falls back to `$XDG_STATE_HOME` / `~/.cache` when there is no config dir (programmatic use); last `~/.cache` use in the tree. A checkout whose parent is read-only needs `SYNC_WORKTREES_LOCK_DIR` (documented).
- T47 (reviewer): scripts/smoke-test.mjs still exports XDG_STATE_HOME (harmless, steers only the audit-log fallback); old-scheme lock files under ~/.cache/sync-worktrees/locks/ are orphaned after upgrade (harmless; operators can delete them).
- T29: nested bareRepoDirs across entries (`/b` and `/b/inner`) are not rejected; path comparison uses path.resolve without following symlinks, so two dirs aliased via symlink slip through (same limitation as the pre-existing checks); an MCP startup whose auto-loaded config fails validation logs the error to stderr and continues with no config loaded (pre-existing).
- T29 (reviewer): `validateWorktreeBareRepoSeparation` still hand-rolls the prefix check instead of `isPathEqualOrInside`; the nested-worktreeDir warning uses console.warn rather than the project Logger (stderr, so MCP-safe).
- T17: on bare repos created by older versions, a frozen refs/heads copy whose remote branch was rebased away reads as 1 local-only commit (no reflog in a bare repo), so the new worktree keeps the old tip (warned + recorded as skipped local_only_commits) and the next sync resets it via handleDivergedBranch; fresh clones no longer carry the copies. `worktree add -B` could not be used because git's branch-in-use check precedes the path check and broke the missing-but-registered recovery.
- T18: if a different process performs the default-branch switch and prunes the old anchor worktree, a long-running process still anchored there fails its next fetch until restart (no in-process self-heal); when `remote set-head -a` fails the fallback picks the first existing name in COMMON_DEFAULT_BRANCHES (pre-existing); `initialize()`'s own fetch lacks `--prune`, so a restart right after a rename switches on the first sync rather than at init.
- T18 (reviewer): the switched default is recorded `created` and `noop/already_up_to_date` in the same sync (cosmetic double count); an LFS retry after the switch drops the default's `created` record via outcome.restore; adoption can pick a default-branch worktree outside worktreeDir (anchor treated as external).
- T3: other `@{upstream}` readers were left alone: mcp/worktree-summary.ts (`get_worktree_status` divergence uses HEAD...@{upstream}, so a no-upstream worktree reports no divergence), worktree-status.service.ts (TUI upstream display / hasUpstreamGone), worktree-metadata.service.ts (falls back to origin/<branch>, fine). Prune's `update-ref -d` leaves `branch.<name>.*` config behind (pre-existing, arguably desirable). canFastForward/isLocalAheadOfRemote still run separate merge-base probes (T2).
- T6: `hasDivergedHistory` (unused in src, mocked in tests) has the mirror bug (simple-git resolves `merge-base --is-ancestor` exit 1 to "", so it reports "can fast-forward" for a non-ancestor and only hits catch → true on real failures); clone mode's `classifyRemoteRelationship` still maps a thrown merge-base on a non-shallow repo to "diverged" (Batch 3 candidate). New skip reason `not_diverged` is undocumented (no reason list exists).
- T6 (reviewer): on the refused-fast-forward entry path a behind-only re-verify result is contradictory and its "fast-forwarded on the next sync" message could repeat each tick (race only); the re-verify uses refs/remotes/origin/<b> while the merge-base probes use origin/<b> (pre-existing dual naming).
- T9 (reviewer): if attempt 1 heals the anchor and the attempt then fails, outcome.restore(baseline) drops the `created` action so the final outcome never mentions the rebuild (same as T18's refresh); the "Recreated" bullet prints before the "Step 1: Fetching" header and its time falls outside every phase timer; WorktreeError/ANCHOR_UNVERIFIABLE vs GitOperationError for analogous "cannot verify path" refusals is inconsistent across the file.
- T19: the `origin/<b>` shorthand class was left unchanged (~12 sites: merge-base divergence probes, merge/reset/checkout targets in git.service.ts, runner:1318 getRemoteCommit, clone-sync switch -c --track); shadowable only by a ref literally named `origin/<b>`, but a misclassification in the divergence probes moves a worktree aside. runner:1318 is also inconsistent with runner:477 in the same file. Ambiguity-warning fail-closed not implemented (simple-git's raw() resolves stdout only).
- T19 (reviewer): standalone `GitService.hasUnpushedCommits` (no production caller) now returns a real answer mid-rebase instead of accidentally returning true via a parse error, and can be false at the start of a rebase of a fully-pushed branch; worth hardening with hasOperationInProgress if it ever gains a caller. A remote branch literally named `origin/x` would create refs/heads/origin/x and shadow refs/remotes/origin/x at every `origin/<b>` site.
- T20 (reviewer): the e2e's precondition regex hard-codes SHA-1 width (`-[0-9a-f]{40}`), which would not match under a sha256 object-format default; the describe-suffix strip would truncate a path genuinely ending in " (...)" on a U line (display-only).
- T24: `list_worktrees`' safeToRemove still reports a locked worktree as removable (inconsistent with what sync now does); the diverged path still records diverged_recovery_failed for a locked worktree and, with trash disabled, divergeWorktree moves the directory to .diverged/ before removeWorktree, leaving a dangling registration (pre-existing; Batch 4 candidate); refusal classification matches English git messages only (same as the pre-existing dirty-refusal match).
- T23: the example config's fetchTimeoutMs/cloneTimeoutMs entries stay COMMENTED because ConfigLoaderService.resolveRepositoryConfig never copies them into the resolved repo config and SyncWorktreesCommonConfigFields does not declare them — uncomment as part of T33. detectDefaultBranch resolves its network client from this.bareRepoPath rather than the passed bareGit (equivalent today, implicit coupling). Up to two simple-git client objects are now cached per path/LFS variant.
- T4: `updateWorktree`'s ff-merge (which does run the smudge filter) still swallows LFS errors through its own Promise.allSettled and records update_failed with no fallback — the remaining place an LFS failure repeats every tick. `retry.maxLfsRetries` now only governs LFS errors that fail the whole attempt (create-path errors never escaped runSyncAttempt anyway).
- T8: on a machine with git-lfs, an LFS repo now pays one `git lfs version` per process plus one `rev-parse HEAD^{tree}` + `git grep` per created worktree before `lfs ls-files`; the attribute gate matches simple-git's "exit code: 1" text (same pattern as check-ignore in worktree-status.service.ts), degrading to "verify anyway" if reworded. The manual 20-worktree timing check could not be run in the sandbox (no git-lfs).
- T62: only the exact refs/remotes/origin/HEAD symref is excluded, so a user-created extra symref under refs/remotes/origin/ would be treated as a branch (filtering on a non-empty %(symref) column would cover it). The short `origin/<b>` ambiguity survives outside the inventory in create/update paths (checkout -B, merge --ff-only, merge-base, revparse) — same class as T19's deferred follow-up. NOTE: the old %(refname:short) parsing did not merely drop feature/HEAD, it injected a phantom branch `feature` into the inventory under branchMaxAge, which would drive a worktree add for a missing ref (fixed here).
- T77: the update phase still never sees a detached worktree (the inventory excludes detached registrations), so it is left alone rather than reported as stale — teaching the planner about detached registrations is a separate task. The TUI status list goes through getWorktrees() and therefore omits detached worktrees, while MCP detect_context/list_worktrees already shows them as "(detached <sha>)".
- T77 (reviewer): ensureMainWorktree still adopts a DETACHED registration at the anchor path (find() over the includeDetached listing with no detached check), so a detached default-branch worktree silently stays the fetch anchor and is never reported — same class, worth a follow-up. The first path-exists exit in addWorktree does not check isPrunable, unlike the two concurrent-op exits (pre-existing).
- T78: knip was evaluated and NOT adopted — it reports nothing for class members (even with --include classMembers), so it would have caught none of the deleted symbols, and its default run yields ~70 intentional findings (MCP bin entry, site/, public config types). It did flag `@types/node-cron` and `ts-node` as unused devDependencies (untouched, plausible follow-up). dist/services/*.d.ts are published, so a deep-importing consumer would lose the deleted methods (nothing documents them as API).
- T78 (reviewer): deleting the GitService facades leaves WorktreeStatusService.hasUnpushedCommits/hasUpstreamGone/hasModifiedSubmodules with no production callers (only their own tests) — a follow-on dead-code item. The package has no `exports` map, so dist/services/*.js is technically deep-importable.

## From T81 review (not a TODO.md item)
- A permissions problem on a *parent* of `bareRepoDir` yields probe verdict
  `"unknown"`, so the user sees the raw `EACCES ... mkdir '<parent>'` from
  `fs.mkdir`, or git's own message, rather than the named
  `CONFIG_BARE_DESTINATION_UNREADABLE`. Both name a path, so it is tolerable;
  mapping the parent case to a named ConfigError would be a polish.

## From T64 review (not a TODO.md item)
- `reapplySparseCheckout` (worktree-mode-sync-runner.ts) compares only the
  pattern list, never the current sparse *mode*, unlike `needsUpdate`. Config
  `{include:['apps','tools'], mode:'no-cone'}` against a cone worktree listing
  `['apps','tools']` builds a textually identical desired list, so
  `patternsEqual` returns true and the cone -> no-cone switch is silently
  skipped. Confirmed by the reviewer against the current code.
- T64 (reviewer): a cone include that normalizes to "." (e.g.
  include: ['.', 'apps'] or ['apps', './']) is retained in our canonical form
  but silently dropped by git's list, so patternsEqual is false forever and the
  config re-applies every sync. Pre-existing, on-disk result is correct. Fix is
  to drop "." only when other entries remain -- dropping it unconditionally
  would turn include: ['.'] into applyToWorktree's "refusing to apply empty
  config" throw.
- T64: a directory name containing a backslash or a quote is C-quoted by git
  regardless of core.quotePath, so those configs still re-apply each sync.
  validateSparseCheckoutConfig also still accepts '..', '.' and leading-slash
  entries (git rejects the last two itself).

## From T2 review (not a TODO.md item)
- MCP `ensureRepoWorktree` (handlers.ts:148-152) trusts a branch name from the
  never-revalidated discovery snapshot (`entry.discovered`, context.ts:766-769)
  for `fetchBranch(worktree.branch)` too. `detectFromPath`'s mtime cache cannot
  see a `git checkout` inside a worktree (only that worktree's admin HEAD mtime
  changes), so the snapshot does not self-heal. T2 fixes the merge path; the
  fetch path keeps using a possibly-stale name. Much smaller blast radius, but
  the same root cause -- the discovery snapshot needs a freshness check.
- T2 (reviewer nit): MCP update_worktree on a branch with no origin
  counterpart now surfaces the raw `INTERNAL_ERROR: fatal: couldn't find
  remote ref wip`. A message naming the branch ("worktree is on 'wip', which
  has no origin counterpart") would read better to an agent. Pre-existing shape.
- T2 (reviewer nit): `ensureRepoWorktreePath` deliberately does not forward the
  `{fresh}` option. Correct today (its one caller is read-only), but a future
  mutating caller reaching for the Path-flavoured helper silently gets the
  stale discovery snapshot.
- T53 (reviewer): the peak model leaves the LFS branch-fetch fallback out
  entirely, so `maxRepositories x min(maxBranchFetches,5)` can exceed the 100
  limit while the loader reports a small number -- 2,245 configs the old rule
  rejected are now accepted in that state (smallest: 21 repos, other knobs at
  1, model says 42, fallback can run ~105 fetches). Narrow (one call site,
  gated on an LFS failure) and now documented, but a real hole.
- T53 (reviewer): split-layer configs still escape the guard. Each layer is
  validated alone and the merged result never is, so
  `{parallelism:{maxStatusChecks:50}, defaults:{parallelism:{maxRepositories:3}}}`
  loads with an effective 150. Repository-level `parallelism` is not validated
  at all. Pre-existing and already in TODO.md (~1713-1722); the new top-level
  layer adds a third way in, so that item should mention it.
- T53 (N4, reviewer, left open deliberately): mcp/handlers.ts:254 builds
  `new WorktreeStatusService()` pinned to the default 20-process budget,
  ignoring the repository's configured maxStatusChecks in both directions.

## From T55 review (not a TODO.md items)
- mcp/handlers.ts:254 builds `new WorktreeStatusService()` with no logger, so
  its lines bypass MCP's createStderrLogger. Safe only because all 12 of that
  service's log calls are `.error` and Logger.error goes to stderr -- one
  `info`/`debug` line added there would write to stdout and corrupt the
  JSON-RPC stream. Also loses the repo-name prefix. The one-line fix needs
  createStderrLogger exported from mcp/context.ts (currently module-private).
- Log lines that reach the console while the TUI is up, unreachable by any
  updateLogger plumbing (so out of T55's scope, but "no service log escapes the
  panel" is not yet true): config-loader.service.ts:662 and :953 (console.warn,
  reached from handleReload via buildRepositories -- duplicate repoUrl or nested
  worktreeDir warnings paint over Ink), utils/disk-space.ts:74 (reached after
  every sync cycle), utils/date-filter.ts:27 (reached during a sync).

## From T56 review (not TODO.md items)
- git-client-cache.ts keys on bare `path.resolve`, not the repo's own
  `normalizePathForCompare` (path-compare.ts), which case-folds on darwin --
  and the package ships `"os": ["darwin","linux"]`. On a case-insensitive
  volume two spellings would be two entries and forget(one) would clear one.
  The reviewer could not construct a reachable failure: initialize() already
  dies with "main worktree ... is not registered" for a symlinked worktreeDir,
  because isRegisteredWorktree uses the same bare path.resolve. Pre-existing
  whole-tool limitation, but the correct helper is one import away.
- Nothing pins that the services actually get a *bounded* cache:
  GIT_CLIENT_CACHE_LIMIT is exercised only via `new GitClientCache(2)` in the
  unit test, so a future edit passing Infinity at the two construction sites
  would fail no test. `countFor()`/`size` are production members with only test
  callers.
- At an unrealistic `maxWorktreeCreation` (~200), the creation phase can insert
  ~600 worktree-path clients between two bare-client uses, so the bare client
  becomes LRU-oldest, is dropped mid-phase, and the rebuilt one brings a second
  5-slot scheduler -- `worktree add` then runs at ~10 concurrent instead of 5.
  Unreachable at the default of 1; pinning the bare/anchor keys out of the
  bound would close it.

## From T57 review (not a TODO.md item)
- git.service.ts:1043-1047 keeps a `GIT_NO_MATCH_EXIT` catch for `git grep`
  that is dead by the same mechanism that killed the check-ignore one:
  simple-git's isTaskError is `exitCode && stdErr.length`, and grep's silent
  exit 1 resolves with "" rather than rejecting (confirmed empirically by the
  reviewer). The fallthrough gives the same answer, so nothing is broken, but
  the constant's comment implies a live path.

## From T58 review (not TODO.md items)
- path-resolution.service.ts:41,68 -- both resolvers' `catch { return absolute }`
  swallows TypeError, not just errno errors, silently degrading a security
  boundary to lexical containment on a programming error. The reviewer
  instrumented the suite and found 395 real occurrences: five suites do a bare
  `vi.mock("fs/promises")`, so fsp.realpath returns undefined and
  `path.join(undefined, ...)` throws. Results still match only because those
  mock paths are already canonical. Narrowing both catches to errno errors
  would need those suites' mocks fixed first.
- The sync and async resolvers are a 20-line copy. Mutation testing showed the
  parity matrix misses several plausible drifts: removing the try/catch
  fallback, changing the existence probe from "any error = missing" to
  ENOENT-only, and the root-terminal return. Worth an "edit together" note or
  two more matrix cases (a base/target whose deepest existing ancestor is
  unreadable AND whose realpath fails).
- A batched-sync alternative (keep realpathSync, `await setImmediate()` every
  N) measured ~3x faster than the shipped async version with an equal or better
  event-loop gap on a local filesystem (7.52ms/0.89ms vs 23.06ms/1.39ms at 400
  on a deep base). It does NOT solve the NFS/SMB case the item names -- a single
  realpathSync there blocks for milliseconds and no batch size yields inside it
  -- so async is right for the stated worst case, but the trade is only clearly
  favourable against the unbatched sync version.

## From T60 review (not a TODO.md item)
- The MCP sequencer's `counted` predicate encodes a convention -- `progress`
  present iff the event is a git transfer event -- that ProgressEvent's
  all-optional shape does not enforce. Misclassification is fail-safe in both
  directions (a phase item growing `progress` demotes to a tick; a transfer
  event losing it is blocked from the zero case by `processed > 0`), and the
  comment documents it, but a `kind` discriminator or a union type would make
  it structural rather than conventional.

## From T12 review (not TODO.md items)
- `sanitizeGitEnv` (utils/git-env.ts) does not strip bare `GIT_CONFIG`, which
  git honours for `git config` writes. With `GIT_CONFIG=/other/repo/.git/config`
  exported, the T12 guard sees a perfectly primary checkout and
  `config --replace-all remote.origin.fetch` narrows the OTHER repository's
  refspec while the run reports "1 synced" -- verified by the reviewer against
  the fixed code. `update-ref -d` is unaffected, so it is a partial T12 through
  a different door. Pre-existing, not a regression; `GIT_DIR`/`GIT_COMMON_DIR`
  do NOT bypass (the guard catches both). Distinct from the
  GIT_CONFIG_GLOBAL/SYSTEM/COUNT allowances.
- `git gc` still runs against a refused directory on the SOFT-skip paths: the
  T12 guard sits after the branch_mismatch/origin_mismatch skips, and
  runMaintenanceIfDueUnlocked (worktree-sync.service.ts:582) runs whenever the
  sync did not throw. Verified: a linked worktree on the wrong branch reports
  "1 with clone-mode skips" then runs gc inside it, i.e. against the parent's
  object store. Much milder than refspec/ref rewriting, but "unreachable for a
  refused repo" holds only for the hard-refusal path. forceClean()'s
  runNowUnlocked() is the same shape.
- Two `rev-parse --git-dir --git-common-dir` spawns per sync when init runs in
  the same operation (initializeInternal then runSyncAttemptInternal).

## From T13 review (not TODO.md items)
- Worktree mode with NO skipLfs and a sparse cone containing an unsmudgeable
  LFS file still dies at "Sparse-checkout setup failed for '<branch>': ...
  smudge filter lfs failed". Identical before and after T13, because
  initialize() runs outside retry(), so the per-sync LFS fallback never arms.
  Not a regression; T13 fixed the clone-mode and skipLfs paths only.
- A clone recovered by the LFS-skip retry is not distinguishable afterwards:
  the incomplete marker is cleared and nothing records that the tree holds
  pointer files, and verifyLfs runs only on the fresh-clone path, so no later
  run warns. Matches how skipLfs clones already behave; deliberate.
- The "never adopted" guarantee is best-effort, not structural: a SIGKILL
  mid-checkout leaves .git complete, HEAD on the branch, a half-written tree
  and NO marker, and the next run adopts it. Unchanged by T13 and outside its
  trigger (a clone that RETURNS non-zero); now documented in the changeset.
  The bare-clone parent-marker shape would close it, but a stale marker there
  would hard-refuse a healthy clone, so it was deliberately declined.
- sparse-checkout.service.ts `applyToWorktree(worktreePath, cfg, gitOverride)`
  takes the path even when the override carries its own baseDir; a future
  caller passing an override built for a different directory would silently run
  the sparse commands in the wrong place. Both current callers match.

## From T14 review (not TODO.md items)
- A systemic hash failure warns up to 201 times per 200-path batch (the batch
  attempt plus each per-path retry). Loud beats silent here, but one rolled-up
  line would read better.
- The undo leaves empty directories behind (`fs.rm` removes files only), so a
  path like `assets/` survives. Harmless -- git ignores empty directories, so
  the tree stays clean and a later fast-forward writes into them -- and now
  disclosed in the changeset.
- RepoOperationLock only excludes other sync-worktrees processes, so a user's
  own concurrent git can fail the merge on index.lock with HEAD unmoved and a
  tree dirtied by their operation. The per-path proof still decides what is
  touched; noted in a comment rather than gated on the failure kind.

## From T15 (not TODO.md items)
- T15's stated defect DID NOT EXIST: simple-git's progressMonitorPlugin already
  appends --progress to any command whose first token is fetch, so the unshallow
  was never silent. Confirmed independently by worker and reviewer (plugin
  source at index.cjs 1432-1466 + pluginContext 1742 + fetchTask 3994, plus two
  separate PATH-shim runs). Only the timeout half of the item was real. Any
  future item citing "the only fetch without --progress" should be re-derived.
- The unshallow does not go through `fetchWithRecovery`, so an LFS error there
  is not retried with GIT_LFS_SKIP_SMUDGE the way the branch fetch is
  (T13/T14 territory). Pre-existing.
- A wedged unshallow now costs 15 min per attempt instead of 5. Scheduled ticks
  absorb it (the next finds the operation in progress and skips), but the
  TUI branch-switch path reaches the same unshallow un-retried with a person
  watching. Not mitigable from config until T33 lands, since neither
  fetchTimeoutMs nor cloneTimeoutMs is copied by resolveRepositoryConfig.

## From T16 (not TODO.md items)
- `InteractiveUIService.calculateAndUpdateDiskSpace` (~line 435) uses
  `config.bareRepoDir || getDefaultBareRepoDir(config.repoUrl)` WITHOUT gating on
  mode, unlike `getRepositoryDiskUsage` which gates on `mode === "worktree"`.
  For a clone-mode repo it therefore sizes the same relative `.bare/<name>` T16
  fixed elsewhere, and can fold a stranger's bare store into the reported
  figure. Read-only display inaccuracy; the reviewer confirmed it is the last
  ungated instance in the UI.
- `getDefaultBareRepoDir` returns a RELATIVE `.bare/<basename of repoUrl>`, and
  the basename alone is the key -- github.com/a/foo and gitlab.com/b/foo both
  map to `.bare/foo`. Worktree-mode callers are safe only because the config
  loader always hands them an absolute bareRepoDir. Left relative deliberately
  (making it absolute risks the loader's own .bare/ resolution), but it is a
  sharp edge for any future caller.
- The check-then-push race relies on `--force-with-lease=<ref>:` (empty expect)
  meaning "must not exist". Verified on git 2.43 both directions; the reviewer
  found no git release where it degrades to a plain force, but the repo
  documents no minimum git version, so this is an undeclared dependency.
- `(stale info)` reaches simple-git's error message only because it goes to
  stdout under `--porcelain` and the default error plugin concatenates stdout
  and stderr. A custom `errors` handler on these clients would silently break
  the race rephrasing.

## From T72 review (not TODO.md items)
- Stale-load race in BranchCreationWizard.loadBranches: selecting repo A,
  pressing ESC, then selecting repo B lets A's later resolution overwrite B's
  list, marker and selection -- the header reads one repository while the body
  shows another's branches. Reproduced by the reviewer on the PRE-T72 commit
  too (via a slow getBranchesForRepo), so it is pre-existing; T72 widens the
  window only for an unconfigured clone on a cold cache. A generation/request-id
  ref in loadBranches closes it.
- resolveBranch() emits `phase: "branch"` progress, which now fires from the
  wizard while the TUI is idle. App clears syncProgressEntries only on
  idle/updateLastSyncTime, so a stray entry can sit in state and flash in the
  StatusBar at the start of the next sync. Sub-second and invisible while idle.
- The wizard has no log channel of its own (no logger/onLog prop), so errors it
  swallows can only be surfaced from the service side. Worth a prop if more
  wizard-local errors need reporting.

## From T73 (not TODO.md items)
- NEW ITEM CANDIDATE: `checkoutBranch`'s no-local-ref arm runs
  `switch -c <b> --track origin/<b>`, which fails on ANY clone-mode repo --
  `remote.origin.fetch` is still narrowed to the previously tracked branch at
  that moment, so git refuses with "cannot set up tracking information;
  starting point 'origin/<b>' is not a branch" (reproduced on git 2.43 by both
  worker and reviewer). Unreachable through today's only caller, because
  createAndPushBranch always leaves a local ref behind and refuses a
  pre-existing one -- which is why no test catches it. Worth its own item.
- `classifyWithDeepening` has no error handling around
  `deepenShallowHistoryToDepth`: a failing deepen fetch escapes checkoutBranch
  as a raw simple-git message, unlike every other failure there, and it has no
  LFS fallback, so a repo whose first fetch needed fetchWithRecovery's LFS
  retry will fail the deepen. Pre-existing on the tick path; the interactive
  path is newly exposed to it. Fails closed (tree untouched, nothing switched).
- `classifyRemoteRelationship` still conflates a merge-base SPAWN error with a
  genuine "no common ancestor" on a non-shallow repo (both -> diverged). A
  latent T6-shaped wrinkle; changing it would turn sync-path soft skips into
  hard failures, so deliberately left.
- `describeDeepenAttempt` was extracted for `detail`, but `progressDetail`
  (~clone-sync.service.ts:1747) still carries its own inline null-check, so the
  same branch condition lives in two places -- the exact shape T73 was about.
- `merge(["origin/<branch>", "--ff-only"])` still uses the shorthand the
  classifier stopped using; a tag literally named `origin/<branch>` would make
  the two disagree about what they compare. Strictly better than before.
- simple-git's `isTaskError` is `exitCode && stdErr.length`, so `merge-base`
  (which writes nothing to stderr) RESOLVES with "" on exit 1. This also makes
  `merge-base --is-ancestor` unusable through simple-git -- exit 0 and exit 1
  are indistinguishable. Same reason worktree-status.service.ts:355 already
  records. Any future item proposing --is-ancestor should be refused.

## From T67 (not TODO.md items)
- The clone-init pending marker is written unconditionally, so after a crash in
  the (now much smaller) window a repository with no filesToCopyOnBranchCreate
  logs "Completing interrupted initialization" and re-runs sparse setup with
  nothing to copy. Pre-existing -- the marker was always unconditional -- just
  reachable in a slightly wider window now.
- The marker write now precedes mutatingClientsFor's primary-checkout
  assertion, so on a pathological `.git`-as-file the write would ENOTDIR first
  and emit a "Could not write clone-init pending marker" warning before the
  proper refusal. Unreachable after a fresh clone into a verified-empty
  destination.
- `git clone --single-branch` already leaves remote.origin.fetch narrowed, so
  configureSingleBranchRemote is largely redundant immediately after a clone
  (reviewer's observation while verifying idempotency). Possible spawn saving.

## T68 (clone-mode sparse narrowing) — remaining nits

- **Narrowing gate is bypassed for a not-yet-sparse checkout (both modes).**
  `readCurrentSparsePatterns` returns null when the checkout has no
  sparse-checkout file, so `isNarrowing` is false and the clean check never
  runs. Adding a `sparseCheckout` block to a repo that was previously a full
  checkout therefore narrows it on the next sync regardless of tree state —
  the single largest narrowing a user can trigger is the one case the gate
  does not cover. README now says so; the behaviour is unchanged.
- **Clone mode does not `recordUpdated` on sparse success.** Worktree mode
  records the sparse re-apply as an update
  (`worktree-mode-sync-runner.ts:163`); clone mode records only the failure
  and the skip. A run whose only change was a sparse re-apply reports
  nothing updated.
- **A sparse failure can mask the real sync failure reason.**
  `worktree-sync.service.ts:568` only records `sync_failed` when
  `counts.failed === 0`, so a sparse-checkout failure recorded earlier in the
  tick suppresses the later, more specific reason.
- **`applyToWorktree` runs `init --cone` before `set`.** If `set` then fails,
  a previously-full checkout has already been stripped to the cone root —
  the failure path leaves the tree narrower than it found it. Worth its own
  item rather than folding it into a "verified" claim.

## T66 (shallow clone depth ratchet) — remaining nits

- **The deepen budget can now shorten an accreted clone.** `getDeepenTargets()`
  refetches at `--depth 50/200/1000`, which re-applies rather than caps, so a
  clone the ratchet grew past the target the budget picks is cut back to it
  (80 commits went to 50). The sync fetch takes the larger of the two; the
  budget does not. Documented at README:442, not fixed.
- **`depth >= 1000` silently empties the deepen budget.** `getDeepenTargets()`
  filters `[50, 200, 1000]` to targets above the configured depth, so raising
  `depth` shrinks the budget and 1000+ removes it entirely — an unclassifiable
  clone can then only be skipped. Documented, but a config-time warning would
  be better than prose.
- **`checkoutBranch`/`createAndPushBranch` re-apply `depth` verbatim to the
  tracked branch.** The wizard offers the tracked branch among its bases, and
  the shallow boundary is repository-wide, so a base fetch of it re-truncates
  a clone the deepen budget had grown (50 commits back to 1). A guard skipping
  `--depth` when the named ref is the tracked branch would fix it; deliberately
  left out of T66's scope.
- **`clone-sync.service.ts:927`** dropped "or raise" from the branch-switch
  indeterminate error. On that path raising `depth` does still work and is far
  cheaper than a full unshallow.
- **README's `depth` section is now ~9 paragraphs** of measured trade-offs for
  one config option — accurate, but longer than the clone-mode section around
  it. Worth folding into a single cost paragraph.

## T71 (clone tick classifies before scanning) — remaining nits

- **`deepenShallowHistoryToDepth` has no `fetchWithRecovery` wrapper.**
  `clone-sync.service.ts:767` calls `networkGit.fetch` raw, unlike the tick's
  main fetch. Now that a dirty + `indeterminate_shallow` tick reaches the
  deepen budget (it used to stop at the tree), that unwrapped fetch is on a
  path it was not on before, so its failure mode reaches more ticks. Worth
  giving it the same recovery wrapper.
- **Cross-mode asymmetry for the non-merging verdicts.** Worktree mode
  (`worktree-mode-sync-runner.ts:1112`) still asks `checkWorktreeStatus`
  before classifying, so a dirty worktree that is ahead or diverged reports
  `dirty_worktree` there while the equivalent clone now reports
  `ahead_unpushed` / `diverged`. The clone-mode naming is the more useful one;
  worktree mode should get the same reorder rather than the two modes
  disagreeing about what to call the same state.
- **Half 2 is deliberately narrow.** The post-clone sync suppression fires
  only when `sync()` performed the init itself (MCP `sync` on an
  uninitialized repo, or an embedder calling `sync()` directly). The CLI
  `--runOnce`, the TUI sync cycle and the TUI config reload all call
  `initialize()` before `sync()` and still run the post-clone tick. Covering
  them needs a token carried across that boundary plus clearing it at four
  entry points that can clone outside a sync; missing one means a sync that
  silently does nothing. With the reorder, what those callers now pay is one
  no-op fetch rather than a full tree scan.

## T74 (converge remote config on drift) — remaining nits

- **No real-git coverage for the actual win.** The "already converged =>
  no writes" path is asserted only against a hand-written mock of
  `git config -z --get-regexp` output. If real git's key casing or `-z`
  record shape ever differs from that mock, the tick silently reverts to two
  writes plus a ref scan per repo per tick and CI stays green. An e2e that
  counts `.git/config` mtimes across two ticks would pin it against real git.
- **`checkoutBranch`'s same-branch convergence no longer sweeps** when the
  refspec already reads narrow, so "run a checkout to converge" has stopped
  being a remedy for out-of-band `refs/remotes/origin/*`; adoption at startup
  is now the only one. Disk only. Passing `{sweepStaleRefs:"always"}` on the
  explicit user-initiated switch would restore it.
- **Switching away and back skips the sweep.** A clone switched off its
  branch by hand and then back has the refspec already stored, so the old
  branch's origin ref lingers. Disk only; closing it costs a per-switch
  `for-each-ref` that finds nothing in the normal case.
- **`clone-init-crash-window.e2e.test.ts:101` matches `--get-regexp`
  unanchored.** Clone-sync is the only caller in src today, so the kill lands
  in the intended window, but any future `--get-regexp` earlier in a CLI run
  would silently relocate the kill point and the test would start proving
  something else. Anchor it.
- **The tarball ceiling is now the only place the package size is stated.**
  Raised 1,250,000 -> 1,400,000 because the old value had 263 bytes of
  headroom and was refusing few-kB changes. The real lever is that esbuild
  does not minify, so every source comment ships in both bundles (~1.07 MB of
  the ~1.26 MB total). Stripping comments from the published bundles would
  reclaim most of it and is worth its own item.

## T75 (batched stale-ref sweep) — remaining nits

- **`git branch -r -D` erases `branch.<name>.*` config, `update-ref -d` does
  not.** Measured on git 2.43: deleting `origin/a` erased
  `branch.origin/a.remote` and `branch.origin/a.merge` while leaving the local
  branch `refs/heads/origin/a` alone. Only reachable when a local branch is
  literally named `origin/<x>` with tracking config, which needs a remote
  branch of that name — contrived, and nothing in the tool reads that upstream
  (the fetch refspec and `merge origin/<branch>` are both explicit). Worth
  knowing if the sweep is ever reused somewhere less constrained.
- **The loose-ref locked case is covered only by a unit double.** The new e2e
  plants its lock on a clone whose refs are packed, so the locked ref is
  deleted too and the lock only forces the non-zero exit. The case where a
  locked ref genuinely survives the sweep has no real-git coverage.
- **`deleteRemoteTrackingRef` still uses `update-ref -d`** for the wizard's
  single `origin/<base>` delete. Correct as is (batching one ref is
  meaningless), but it means two different deletion commands now exist side by
  side with different symref semantics — `update-ref -d` was measured to
  delete a symref's target too, which is part of why the sweep moved off it.

## Repo hygiene — apply directly, not via a task loop

- **`tmp-e2e-*` is not in `.gitignore`.** The e2e suite creates
  `tmp-e2e-clone-mode/`, `tmp-e2e-worktree-mode/` etc. in the repo root, each
  holding real scratch git repositories (`*.git`, seeds, checkouts). They are
  cleaned up when a run finishes, but while a suite is running `git status`
  shows them as untracked, and any `git add -A` during that window commits
  throwaway repositories into the project. Add `tmp-e2e-*/` to `.gitignore`.
  (Directly related: the one real mistake this session was a `git add -A` that
  swept a running agent's partial edits into an unrelated commit.)

## T76 (clone-mode phase timing) — remaining nits

- **`timePhase`'s `finally` is not pinned by any test, and I could not write
  one that pins it.** `PhaseTimer.startPhase` already closes an open phase, and
  `getResults()` closes one too, so the `finally` only changes an observable
  value when the LAST phase throws AND time passes before the table renders.
  Two attempts to construct that window (asserting a bounded merge row; then
  spending fake clock inside the `logger.info` that `sync`'s `finally` makes
  between the throw and the render) both passed with the `finally` removed, so
  both were dropped rather than kept as tests that pass either way. The code is
  correct and the comment explains why it is there; the promise is simply
  unpinned. Anyone revisiting: a real-clock test, or exposing `PhaseTimer`'s
  open-phase state, are the two routes left.
- **First sync of a repo still prints one row.** A clone-mode sync that
  performs the clone itself logs "no fetch is needed" and prints
  "Total Sync 107ms" with no phase rows, because init runs inside the total
  timer but outside every phase. Honest, and identical to worktree mode, but
  the user whose first sync is the slow one gets nothing. Not T76's job.
- **Near-verbatim rationale duplicated** between the `CLONE_SYNC_PHASES`
  comment (clone-sync.service.ts:31-40) and the changeset's second paragraph.
  No measurement is duplicated, so the one-place rule holds in the letter, but
  it is the same argument written twice.

## T65 (strip repository-selection env vars) — remaining nits

- **Use `git rev-parse --local-env-vars` as the citation.** The hand-kept
  "Deliberately kept" paragraph in git-env.ts misses five variables git itself
  classifies as repository-local. On 2.43 the command prints:
  GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_CONFIG, GIT_CONFIG_PARAMETERS,
  GIT_CONFIG_COUNT, GIT_OBJECT_DIRECTORY, GIT_DIR, GIT_WORK_TREE,
  GIT_IMPLICIT_WORK_TREE, GIT_GRAFT_FILE, GIT_INDEX_FILE,
  GIT_NO_REPLACE_OBJECTS, GIT_REPLACE_REF_BASE, GIT_PREFIX, GIT_SHALLOW_FILE,
  GIT_COMMON_DIR. Of the eight this change still forwards, only
  GIT_CONFIG_COUNT and GIT_PREFIX are accounted for. Citing the command
  answers the 2.43-vs-2.55 version question by construction instead of by a
  list someone has to maintain.
- **GIT_SHALLOW_FILE is the one forwarded variable with a measured effect on a
  path this tool runs.** Clone mode has an unshallow client. Measured on 2.43:
  pointed at another repo's absent shallow file, `fetch --unshallow` gives
  "fatal: --unshallow on a complete repository does not make sense"; pointed
  at a stale copy, `fetch --depth=3` gives "fatal: shallow file has changed
  since we read it". It does not redirect a write, and no hook exports it, so
  it is not urgent — but it belongs in the set or in the comment.
- **Four of the ten stripped variables are pinned only by spelling.**
  GIT_NAMESPACE, GIT_CEILING_DIRECTORIES, GIT_DISCOVERY_ACROSS_FILESYSTEM and
  GIT_CONFIG are covered by the literal-list assertion in git-env.test.ts but
  by no behavioural test: removing each individually leaves the e2e green. The
  list test does fail, so none can be silently narrowed — but what pins them
  is a name, not a consequence.

## T69 (file copy stays out of sibling checkouts) — notes

- **An alias inside the source pointing back at the source (`self -> .`) still
  lets the source's own files be copied under the alias path** (`self/.env`,
  `self/self/.env`). Deliberate and asserted by a test: that is the user's own
  file matching the user's own pattern, not a foreign checkout's. Worth knowing
  if the rule is ever tightened.
- **An exclusion entry containing the copy source contributes no canonical
  path**, by design — honouring it would silence the whole copy, which is
  exactly what worktree mode would hit, since it copies from a worktree inside
  the repository's own `worktreeDir` and the caller lists that `worktreeDir`.
  Its lexical name is still kept when the config spelled one inside the source.
- **Cost of the fix:** every directory the walk reaches is now canonicalized
  (`realpathSync` via path-scurry, cached). Not measured against a large tree;
  the audit's own T69 note about a worktree-mode sibling holding 50 worktrees
  suggests where to look if branch creation ever feels slow.

## T70 (partial-clone cleanup tests) — a real hole found, NOT fixed

- **`cloneCreatedDir` does not establish ownership — TOCTOU on the only
  `rm -rf` in clone mode.** `clone-sync.service.ts:1573` sets it from
  `entries === null` (an ENOENT readdir), which records that the destination
  was ABSENT a moment earlier, not that this process created it. The very next
  line is `fs.mkdir(worktreeDir, { recursive: true })`, which is silent when
  another process won the race. So a directory another process created in that
  window, holding only dot-prefixed entries and no `.git/HEAD`, satisfies all
  three guards and is deleted — and `git clone` into such a directory fails
  with "destination path already exists and is not an empty directory", which
  lands exactly on this arm. Narrow (needs a concurrent creator racing into the
  exact configured `worktreeDir`, and this tool's own per-repository lock stops
  two of its own instances), but the guard's comment claims an ownership the
  check does not establish. Cheap close: a non-recursive `fs.mkdir(worktreeDir)`
  after the parents exist, treating EEXIST as "not ours" and downgrading
  `cloneCreatedDir`. Deliberately not fixed — T70 is a tests-only task, and
  this is a source change that deserves its own item.
- **`mkdir -p` may create PARENT directories the leaf-only cleanup leaves
  behind.** A failed clone into `/a/b/c` where none of `a`, `b`, `c` existed
  removes only `c`.
- **No e2e for the `rm -rf` arm.** The unit tests plus killed mutants are what
  the acceptance asked for; the existing `incomplete-clone-checkout.e2e` covers
  the checkout-failed sibling, not this path.
- **Test 4 counts `fs.access` calls on HEAD to distinguish the two reads.** If
  a future change adds a third HEAD probe upstream, the test keeps passing but
  stops meaning what its comment says — coupled to call ordering, not to a
  cause. Acceptable only because the branch is reachable solely by a race.

## T26 (legacy flat trash pin refs) — remaining notes

- **Cross-workspace collision the widening technically reintroduces.** Two
  workspaces sharing a `bareRepoDir`, both holding legacy entries with the same
  id, would now have one workspace's reap delete the other's flat pin. Colliding
  requires the same millisecond, the same sanitized basename and the same 3
  random bytes from `generateId` — and 5.0.x/5.1.0 itself already corrupted such
  a pair at creation time, so the widening does not create the hazard. Worth a
  sentence rather than a fix.
- **`isOwnPinRef`'s safety rests on an invariant enforced 300 lines away.** The
  comment says `<id>` "is a single directory name read out of the trash root and
  so contains no separator" — true, because `listEntries` is the only
  `readManifest` caller and builds `containerPath` from a `readdir` dirent. A
  future caller passing a constructed path would void the guarantee silently. A
  one-line note at the `readManifest(containerPath)` call site would hold it.
- **Uppercase-hex root hash is unpinned.** Changing `/^[0-9a-f]{16}$/` to
  `/^[0-9a-fA-F]{16}$/` leaves both trash suites green. Case-sensitivity is
  correct (`computeTrashRootHash` emits lowercase) and accepting uppercase
  would not weaken the delete guard, so this is a coverage gap rather than a
  hole. One more `it.each` row closes it.
- **No one-shot migration of legacy manifests into the hashed namespace**
  (option b in the spec), deliberately: the three-step write path (create
  hashed ref, delete flat ref, rewrite manifest) has partial failures that land
  exactly on the hazard the namespacing exists to prevent — a manifest naming a
  ref that no longer exists, i.e. an entry whose commits become gc-eligible.
  Legacy entries converge on their own inside the 30-day retention window. The
  one residue: a flat ref whose container was already gone before the upgrade
  is never swept (the sweep cannot tell it from another workspace's) and must
  be dropped by hand. Now stated in README.

## T27 (trash delete ordering) — remaining notes

- **The final step is still one non-atomic recursive rm over manifest.json (+
  commits.bundle).** If it is refused at the container's own rmdir — a
  non-writable `.trash` root is the realistic case — Node unlinks manifest.json
  first and leaves an empty, manifest-less container. That is the same end
  state the changeset discloses for a process kill, reached by a refusal
  instead. Bounded: the payload is already gone and the pin already released,
  so nothing is stranded but an empty directory. Closing it properly needs the
  manifest unlinked last, on its own, after the bundle.
- **The reaper test "releases the pin once the payload is gone, even when the
  container itself cannot be deleted" relies on the fake.** Its
  `entries`/`invalid` assertions hold only because the fake never deletes the
  declared survivor; with a real EACCES on the rmdir the manifest would be gone
  and `invalid` would be `[container]`. Fine as a pin on the pin-ordering,
  misleading as a statement about the end state.
- **A `payload.deleting-*` left behind by RESTORE's cleanup is swept only once
  the entry expires.** `removeTrashPayload` is the only sweeper, and of its
  three callers only the reaper revisits an existing container, and only past
  expiry. That disk can be held for the rest of the retention window with no
  further message. Strictly better than the old unreclaimable container, but
  worth a sweep on any revisit.
- **An entry that stays valid-and-listed because its payload cannot be deleted
  keeps reserving its branch** in `getPendingDivergedBranches`
  (worktree-mode-sync-runner.ts:283-296), past expiry, and that reservation now
  protects nothing — restore of a mid-delete entry is refused by design. The
  comment above that function calls an unexpirable reservation exactly the
  problem it is now creating.
- **undoPartialTrash's ordering is untestable as written.** That path never
  sees a payload in the container (the rename either had not happened, or the
  rollback renamed it back out first), so the shared helper's ordering cannot
  be distinguished there. Its test pins what did change: the failure is
  reported rather than swallowed by `.catch(() => undefined)`, and the leftover
  is a valid, listable, ageing-out entry.

## T28 (force clean binds to what it showed) — remaining notes

- **One rationale still restated in three files.** "Preview taken outside the
  repo mutex, confirmed an unbounded human pause later, so a sync in between
  adds entries" appears in `types/index.ts` (ForceCleanSelection docblock),
  `worktree-sync.service.ts` (forceClean comment) and the force-clean e2e
  docblock. The modal and InteractiveUIService comments are about their own
  local decisions and are fine. Trim to one.
- **A selected, present entry that fails the reaper's realpath guard survives
  silently.** `trash-reaper.service.ts:113-123` — no `errors` entry, no skipped
  count; the modal just prints a smaller `deleted` number than the preview
  promised. Pre-existing and near-unreachable (listEntries already drops
  symlinked dirents, and the repo mutex excludes concurrent deletes), but it is
  now the one remaining way a purge can under-deliver without saying so.
- **Force clean still skips the keep-ref migration for `keepPinOnReap` entries**
  (the `!purgeAll` guard in the reaper), and the preview does not say "N of
  these hold the only copy of never-pushed commits". That is a disclosure
  question rather than a set question — deliberately out of T28's scope, but it
  is the information a user most needs before confirming.
- **The mutex alternative was rejected deliberately.** `runExclusiveRepoOperation`
  takes a cross-process file lock, so holding it from preview to confirmation
  would stop cron syncs and other processes for as long as the modal is open —
  and the modal has no timeout. The snapshot's worst case is a purge that
  under-deletes and reports it; the mutex's worst case is a frozen daemon.

## T11 (verbatim symlinks in preservation copies) — remaining notes

- **`fs.cp` cannot preserve hard links, before or after this change.** Measured:
  a hard-linked pair comes out of `fs.rename` with `nlink=2` and out of `fs.cp`
  with `nlink=1` under both old and new options. Pre-existing and out of T11's
  scope, but it is the one way the cross-device fallback still differs from the
  rename it substitutes for. Anyone relying on hard links inside a worktree
  loses them when a diverge crosses a filesystem boundary.
- **The "assert only after the source is deleted" rationale is written out in
  all three test files.** Each comment guards its own test against a future
  reorder, so the duplication is defensible — but it is the same paragraph
  three times, and the one-place rule would put it in the helper's doc with a
  pointer.
- **A relative link escaping the copied tree now dangles in the diverged path.**
  `.diverged/<name>/` is one directory deeper than the worktree was, so
  `../../shared/thing` resolves elsewhere after the move. This is deliberate —
  it matches what `fs.rename` produces on the fast path, and the old behaviour
  was inconsistent between the two branches — but it is a real change for
  anyone whose worktree links out to a sibling directory. Documented in the
  helper.
- **`FileCopyService.copyFile` deliberately left on `fs.copyFile`.** It
  materialises per-worktree files from a live source that keeps existing, so
  there is no delete to break a link; and `fs.copyFile` has no verbatim notion
  anyway. If it ever grows a directory-copy path, it needs this decision
  revisited.

## T7 — trash sizing (leftover, not done)
- `measureTrashSizesOffLock` is a no-op in clone mode (`if (this.cloneSyncService) return`). Clone mode does
  trash directories (T12/T13 paths), so those entries are only ever sized by a force-clean preview. Either
  clone-mode ticks should measure too, or the early return deserves a reason it does not currently carry.
- The rationale for "sizing must not run under the lock" is now stated in three places: `trashDirectory`'s
  `sizeBytes: null` comment, the HEAD re-verification comment below it, and the `sync()` finally block.
  They say compatible things today; nothing keeps them in step.

## T82 — branch config sections (leftovers, not done)
- Clone mode has the same leak in a narrow window: if `[branch "foo"]` exists in a clone WITHOUT
  `refs/heads/foo` (a successful `-u` push earlier, then the ref removed by something that does not
  clean config), `CloneSyncService.createBranch` passes its `localBranchExists` guard, creates
  `foo --no-track`, fails the push, CAS-deletes at clone-sync.service.ts:1473, and strands the
  section. The same one-line helper closes it.
- No sweep exists for `branch.*` sections orphaned by earlier versions or by a hand-deleted branch.
  `git-maintenance.service.ts` is the natural home if it is ever wanted. Deliberately declined here:
  it is a repo-wide mutation with its own race surface and outside T82's acceptance criteria.
- `git config --remove-section` is not retried when another `git` holds `config.lock` (exit 255, no
  lock timeout). Fail-soft is right for this caller; noting it in case a caller ever needs it to be
  reliable.
- `GitService.deleteRef` is an unguarded generic `update-ref -d`. Every current caller passes a trash
  pin or `refs/sync-worktrees/keep/*`, so none can strand a branch section today — but nothing in the
  signature stops a future caller passing `refs/heads/*`.
- `TrashService.deleteTrashedBranchRef` has exactly one production caller
  (`trashAndUnregisterWorktree`), so prune, manual removal, force-clean and diverged-replace all
  converge on the single fixed path. Worth knowing if a second caller is added.

## T83 — adopted .diverged keep refs (leftovers, not done)
- No convergence sweep for a crash-orphaned legacy keep ref. If the process dies between adoption and
  release, nothing comes back for it: `.diverged/<name>` is gone so migration will not retry, and only
  force clean removes it. The information to reconcile DOES exist (the manifest records
  `legacyOriginalName`, and `keep/<legacyOriginalName>` is derivable), so a sweep at reap time could
  converge — but it must not delete a ref whose `.diverged/` directory still exists, which is the case
  `forceClean`'s `isKeepRefReserved` protects.
- `writeDivergedInfoFile` has two duplicated instruction branches, and the adoption rewrite adds a
  third variant of the same prose in a different file. A shared helper would keep them from drifting —
  drift is exactly what produced the false "nothing to do" wording caught in review.
- The reaper names the promoted keep ref `keep/<trashId>`, and for an adopted entry the trash id is
  `<timestamp>-<legacyName>-<suffix>` — itself already doubly timestamped. That is the string the
  `--dropKeepRef` confirmation makes the user type exactly.
- `trash.service.ts` `undoPartialTrash` swallows `deleteRef` failures with `.catch(() => undefined)`,
  with no warning at all, unlike the reaper's equivalent which logs and collects. A pin ref stranded
  there is invisible. Pre-existing.
- `src/utils/atomic-write.ts` is at 70.58% statements / 25% branches — its EXDEV fallback and
  unlink-cleanup paths are untested. T83 adds a caller but no coverage there.

## T84 — force-clean gc (leftovers, not done)
- Scheduled `maintenance.aggressive` has the IDENTICAL corruption exposure and no busy probe. Left
  alone deliberately: it is opt-in and README documents the hazard, and wiring the probe into
  `runIfDueUnlocked` would change behaviour for every aggressive user's scheduled runs. Small,
  self-contained follow-up.
- The bare repo has no reflogs for pushes (`core.logAllRefUpdates` defaults false for `--bare`),
  though commits made IN a linked worktree DO write both `<bare>/logs/refs/heads/<branch>` and the
  per-worktree HEAD reflog (git treats itself as non-bare when run from the worktree). Setting
  `core.logAllRefUpdates` on the bare clone would be a cheap, broad safety improvement well beyond
  force clean.
- `fatal: cannot lock ref 'HEAD'` aborts a small fraction of concurrent commits under ANY gc,
  including today's plain scheduled one. Loses nothing, unrelated to prune policy, nobody has filed it.
- `gc.log` bailout is not surfaced: a repo wedged by a failed gc reports only "Maintenance failed".
- The busy probe has no override. A worktree parked mid-`rebase-merge` for a week blocks force
  clean's gc indefinitely; the error names the worktree and marker and the README now names the
  remedy, but there is no `--force` escape hatch.
- `MERGE_HEAD` / `CHERRY_PICK_HEAD` / `REVERT_HEAD` do NOT themselves protect their commits from
  `--prune=now` (measured); what saves a real conflicted merge is the worktree HEAD reflog.

## T85 — manifest ref arguments (leftovers, not done)
- An invalid trash entry is IMMORTAL: never listed, restored, reaped, or force-cleaned (forceClean
  purges only ids the preview collected from valid entries), and its pin ref holds objects forever.
  There is no `sync-worktrees trash --purge-invalid <id>`; cleanup is manual `rm -rf` plus a manual
  `update-ref -d` for the pin. This predates T85 — T85 only widens the bucket — but it is now the
  single largest untended failure mode in the trash subsystem.
- The reaper's invalid-entry warning is once-per-process (`warnedInvalidPaths` rebuilt each run), so
  in a long-lived daemon a steady-state invalid entry is announced at startup and never again. The
  durable surfaces are the CLI listing and a bare count in the force-clean modal.
- Four `git.service.ts` call sites still pass branch names positionally without `--`: the batched
  clone-time `branch -D` sweep, the branch-create rollback, `createWorktree`'s fallback
  `worktree add`, and the failed-worktree-add cleanup. All take names from git's own ref listings or
  local variables, so none is manifest-reachable; `createWorktree`'s fallback is `addWorktreeNoCheckout`'s
  sibling and would benefit from the same separator for consistency.
- `isValidGitBranchName` (the MCP create_worktree validator) is deliberately stricter than git and
  still rejects `v1./x` for CREATION. That is a defensible product choice, but it means the tool
  refuses to create names it can now correctly restore — worth a deliberate decision rather than
  an accident of history.

## T86 — keep refs (leftovers, not done)
- **simple-git adds a fixed 50 ms to every git command that prints nothing** (dist/cjs/index.js:1283,
  `await delay(50)` when deferClose). Measured 55 ms/ref for `update-ref -d` through the client vs
  3 ms via child_process — an 18x tax. This affects EVERY silent git command the tool runs
  (update-ref, symbolic-ref, config, worktree prune...), not just ref deletion. A repo-wide fix
  (a client built without the completion-detection plugin, or chunked `--stdin` spawned outside
  simple-git) is worth its own task; it was out of scope here and the 50 ms exists to catch late
  stderr, so it is not a drive-by.
- Force clean's audit volume is 2 fsync'd records per ref (~2.5 s for 2000). Batching needs
  `RemovalAuditEntry.path` to accept a list — a schema change to a user-readable JSONL log — and the
  "attempt" record is a fail-closed gate, so batching changes the crash-safety story.
- Nothing records a keep ref's mint time, so `--older-than <days>` is not implementable:
  `%(creatordate)` reports the COMMIT's date, and `git gc` runs `pack-refs` which deletes the loose
  ref file, so mtime is gone after one maintenance window. A sidecar note or an audit-log scan would
  be needed first.
- `deleteKeepRefs` validates every name up front and throws, so one hand-made nested ref
  (`keep/a/b`) makes `--dropAllKeepRefs` permanently unusable. Tool-minted ids can never hit it.
  Skipping-and-reporting would be more robust than refusing the run.
- `deleteKeepRef` (single) has no `.diverged/` reserved check while the new batch path does, so
  `--dropKeepRef <diverged-name>` destroys a ref `--dropAllKeepRefs` deliberately retains.
- The new retained/errors output prints FULL ref paths while `trash` lists and `--dropKeepRef` takes
  SHORT names, so a user cannot paste what they are shown.
- A reaped keepPinOnReap entry whose headOid git can no longer resolve defers its reap forever
  (updateRef fails -> continue on every tick). Currently unreachable because the pin protects the oid.
- `{ wait: true/false }` is untested for deleteKeepRef, deleteKeepRefs and forceClean alike.
- TOCTOU inside the freshness gate: fetch runs at the start of the attempt, the reap in the sync's
  finally, so a branch deleted upstream mid-sync leaves a stale ref while remoteRefsFresh is true.
  One sync's window, inherent to a point-in-time check.

## T87 — restore by rename (leftovers, not done)
- The files-only restore path (`restore()`'s non-worktree branch, entries with no pin) is still a bare
  `fs.rename(payloadPath, originalPath)` with NO EXDEV fallback — on a split device it fails outright,
  payload intact. Pre-existing; `copyTreePreservingSymlinks` is right there for symmetry.
- README's manual recovery recipe still says `cp -R payload/. <path>` + `worktree repair`. Still
  correct, but it could be updated to the O(1) `rm -rf <path> && mv payload <path>` form the tool now
  uses.
- The restored directory now carries the PAYLOAD's mode (the original worktree's) rather than the one
  `worktree add` created. Arguably more faithful; nothing asserts it either way.
- The "finish by hand" error on the double-failure path suggests `git -C <path> reset`. If the admin
  name was not reused, the stale link points at another worktree's admin dir and `reset` would operate
  on the wrong index rather than failing. Naming `git -C <bare> worktree repair <path>` first would
  cover both. (Narrowed by this round's reorder — the link is now correct before the move — but the
  branch is still reachable when the rollback rename itself fails.)
- The EXDEV fallback re-`mkdir`s the directory git made, so it carries the process umask rather than
  whatever git left.
- `git worktree add` at a missing-but-registered path fails, so a crash in the pre-rename window costs
  TWO restore attempts: the first fails and clears the registration, the second succeeds. Pre-existing
  shape, not introduced here.

## T89 — trash CLI (leftovers, not done)
- **SEMVER**: I changed this changeset from `patch` to `minor`. Three new CLI flags are added
  functionality, and the project's own 5.2.0 was a minor for adding this same trash CLI surface.
  Changesets aggregate to the highest bump, so THIS PR NOW RELEASES AS 5.4.0 rather than 5.3.2.
  The other 68 changesets remain patch. Flagged to the user.
- The duplicate keep-ref line remains: on a successful purge the reaper logs "Commits remain
  recoverable at '<ref>' (<oid>)" through the repo logger AND the CLI prints "Commits kept at
  '<ref>' (<oid>)". Same ref, same oid, twice. The real fix is a quiet-by-default logger for
  one-shot commands — service `info` logs interleaving with CLI output is the underlying issue.
- `--restore ""` / `--purge ""` fall through to a listing and exit 0 (truthiness check), so a script
  running `--purge "$ID"` with an unset variable gets a table and a success exit. On a destructive
  flag that deserves an explicit rejection.
- The `--wait` announcement tests `options.restore !== undefined` while dispatch tests truthiness,
  so `--restore "" --wait` announces a wait and then prints a listing.
- `purgeAll` in `reapUnlocked` is now a misnomer — it means "selection-based", not "all", and drives
  the audit action, the expiry skip and the wording. Rename to `isSelection`.
- A keep ref minted by a FAILED purge leaks: the ref stays alongside the still-live pin for an entry
  still in the trash, and if that entry is later restored the pin is dropped but the keep ref is
  permanent. Fails safe, but it will show up in `--dropAllKeepRefs` forever.
- "was not deleted and stays listed" understates a partial failure: the payload may already be
  renamed to `payload.deleting-*` and partly removed, so the entry is listed but no longer
  restorable.
- `--wait` bounds only the cross-process lock; the in-process mutex still queues unbounded under
  `wait: true`. Harmless for a one-shot CLI, confusing to read.
- `runList`/`runSync` catch broadly and `process.exit(1)`; `trash` now uses a narrow catch plus
  `process.exitCode`. Converging them is a small separate cleanup.
- `--purge` takes one id, not a list — clearing several entries means one confirmation each.

## T90 — real-git trash coverage (leftovers, not done)
- `restoreAsWorktree` calls `createBranchAt` OUTSIDE its own try/catch, so when the pinned commit is
  gone the user gets a raw GitError (`fatal: not a valid branch point: '<oid>'`) instead of the
  "trash entry left intact" wrapper every later step produces. The new e2e documents this and asserts
  only that the error names the missing commit. Wrapping it is a small behaviour improvement.
- Sparse-checkout re-application on restore (`applyToWorktree` in `restoreAsWorktree`) still has no
  real-git coverage; a restored sparse worktree reporting out-of-cone files as deleted would not be
  caught.
- The `.diverged` -> trash adoption path (`releaseAdoptedKeepRef`) is covered only against stubs; the
  new force-clean e2e deliberately sets `migrateLegacy: false` rather than exercising adoption.
- The legacy keep-ref name heuristic in `isKeepRefReserved` (the `diverged-<stamp>-<branch>` regex
  plus substring match against directory names) is untested at the object level — only the
  exact-name case is covered.
- `makeLegacyDivergedBackup` writes a `.diverged-info.json` whose `keepRef` field nothing in that
  flow reads (`getDivergedDirectoryNames` reads directory NAMES only), so it could drift from the
  real ref name and no test would notice.
- The force-clean object assertions only exercise `maintenance.aggressive: true`. Under the default
  `--prune=1.hour.ago` none of the just-made objects would be pruned; that path is covered by the
  maintenance e2e instead.

## Environment note for this sandbox (not a repo issue)
- `rm -rf` on the repo working tree DOES NOT BEHAVE here: a reviewer ran `rm -rf src`, the directory
  stayed in place, an older overlay layer was exposed (17 files reverted, 2 new files gone), and it
  also corrupted a `cp -a` scratchpad copy. Recovery was `git archive HEAD src` plus a sha256 baseline.
  Use a tarball, not a directory copy, and do not `rm -rf` inside the repo.

## Coordinator note (Batch 5 ordering) — T31 vs T33

T31's worker verified that `fetchTimeoutMs`/`cloneTimeoutMs` are silently dropped by
`resolveRepositoryConfig`, and on that basis wrote prose into
`sync-worktrees.config.example.js` telling readers the keys have no effect.

That is the *same* defect as TODO item **T33**, whose preferred resolution is option (a):
wire the knobs up for real. If T33 lands after T31 unchanged, the example's prose becomes
false and the release changelog would carry two contradictory entries in one release
("these knobs are inert" + "these knobs now work").

DECISION: run **T33 immediately after T31**, ahead of T32. The T33 worker must:
  - update the example file's timeout prose to document them as real settings, and
  - rewrite `.changeset/t31-example-config-loads.md` so it no longer asserts the keys are
    inert (nothing here is released yet; the changelog must describe the end state).
Also note README:686 and README:701 — T31 deliberately left README alone as out of its
scope; T33 owns fixing README:686's "Both knobs are documented in ..." claim.

## T31 follow-ups (from the adversarial review)

- **FU-T31-1 (folds into the T33 ordering note above).** `README.md:686` still presents
  `fetchTimeoutMs`/`cloneTimeoutMs` as settable ("`0` disables one", "Both knobs are documented
  in sync-worktrees.config.example.js") while the example now says writing them has no effect.
  README and example now contradict each other. T33 must also delete the example's drop-guard
  exemption reasoning, not just the prose.
- **FU-T31-2.** README:701 sends readers to the example for "sparse-update behavior", but the
  example's `skipUpdateWhenOutsideSparse` comment never says it is worktree-mode only (sole
  consumer: `worktree-mode-sync-runner.ts`). The clone-mode section says "sparseCheckout … still
  apply", which invites setting a key that is silently ignored. `src/types/index.ts:29-38` has
  the same gap. Overlaps T92.
- **FU-T31-3.** The lock comment says `<parent of worktreeDir>` where the code uses the parent of
  the *canonicalized* worktreeDir; operationally identical, and it matches README:511 verbatim, so
  it was left alone rather than diverge from README. Same paragraph says "Nothing in the
  environment feeds into that path" and then names `SYNC_WORKTREES_LOCK_DIR`, which does — an
  inherited README wording problem.
- **FU-T31-4.** Unknown / silently-ignored config keys still load with no warning. The new test
  catches a typo *in the example*; nothing protects a user's own file. This is T92.
- **FU-T31-5.** The example carries `// @ts-check` + `@satisfies {SyncWorktreesConfig}`, but
  `tsconfig.json` includes only `src/**/*`, so CI never type-checks it — the annotation is
  editor-only decoration. A `tsc --noEmit --allowJs` pass over the file would make the public
  config types a real guard on the reference file.
- **Surviving mutants accepted on T31** (documented, not defects): a `sparseCheckout` block on a
  clone-mode entry loads and is silently ignored (belongs in the loader, see FU-T31-2/T92);
  *added* misinformation inside the lock comment (the test asserts `toContain`, so it cannot see
  text added around the pinned substrings); and prose about *when* the reaper runs (not cheaply
  machine-checkable — mitigated by fixing the stale src comment that caused the error).
- **Note for release review.** `package.json#files` is `[bin, dist, README.md, LICENSE]`, so
  `sync-worktrees.config.example.js` never ships to npm. T31's changelog entry describes a
  repo-only artifact.

## FU-BUILD-1 — `pnpm build` never cleans `dist/`, so stale output ships

Found while checking a T33 worker note. `package.json#files` is `["bin","dist","README.md","LICENSE"]`
— the WHOLE of `dist/` — and `esbuild.config.js` has no clean step, so anything ever emitted into
`dist/` persists and is packed forever.

Demonstrated concretely: `dist/__probe__/old-file-copy.d.ts`, a leftover from an earlier session's
throwaway probe, was listed by `npm pack --dry-run` (574 B, file 90 of 90). Removing it dropped the
tarball to 89 files. It was untracked (`dist/` is gitignored) so it never reached the PR, and CI
builds from a clean checkout — but a maintainer who publishes locally would ship every stale
artifact they have ever produced, including the `.d.ts` of any source file since renamed or deleted.

Fix: clean `dist/` at the start of the build (or pack from a clean checkout only). Worth a guard in
`scripts/smoke-test.mjs`, which already asserts "no source maps" and size ceilings but not "no files
without a corresponding source".

NOTE for my own measurements: local smoke runs before this cleanup counted 90 files; CI counts 89.
The T33 worker's reported 1,432,411 bytes therefore includes 574 B that CI does not have.

## T33 follow-ups

- **FU-T33-1. No lower bound on the timeouts.** `fetchTimeoutMs: 1` validates and would kill
  essentially every fetch. Mirrors the pre-existing `validateDepth` (which allows `depth: 1`), so it
  is house-consistent and was left alone. If a floor is wanted, both validators should get one
  together.
- **FU-T33-2. `retry` validation is much looser than `depth`/timeouts.** `initialDelayMs`,
  `maxDelayMs`, `jitterMs`, `maxLfsRetries` are checked only for `typeof === "number"` plus a bound,
  so `1.5`, `NaN` and `Infinity` all pass (`NaN < 0` is false). `retry.maxAttempts` likewise accepts
  `2.5`. Same class of hole T33 just closed for the timeouts.
- **FU-T33-3. `trash.retentionDays` / `warnSizeBytes` use `Number.isFinite`, not
  `Number.isSafeInteger`**, so `retentionDays: 0.5` is accepted. Third inconsistent validator style
  in the same file. FU-T33-2 and -3 together argue for one shared numeric validator.
- **FU-T33-4. `validateDepth` carries the same redundant `typeof` arm** that `validateTimeoutMs`
  does (unreachable at runtime — `Number.isSafeInteger` never coerces — but load-bearing for type
  narrowing). Noting so nobody "fixes" one without the other.
- **FU-T33-5. The `defaults` half of T31's drop guard is weaker than the repository half**
  (`config-loader.example-config.test.ts:105-110` uses `repositories.some(repo => key in repo)`, so
  one repository carrying the key clears it for all). Pre-existing, untouched by T33, and moot for
  the timeouts since the example leaves them commented out under `defaults`.
- **FU-T33-6. `unshallow-inactivity-timeout.e2e.test.ts` still hand-builds a `Config`** rather than
  going through the loader. `cloneTimeoutMs` reaching the *unshallow* client is covered
  compositionally (loader test proves resolution; `clone-sync.unshallow.test.ts:165` proves the
  service honours it) rather than by one end-to-end test.
- **FU-T33-7. `src/services/__tests__/git.service.test.ts` contains 21 literal NUL bytes**
  (intentional `for-each-ref -z` fixtures). Harmless, but `grep` treats the file as binary and
  silently skips it, so a plain `grep -rn <symbol> src` under-reports. Use `grep -a`.
- **Still open from T31, unchanged by T33: the shipped example is not type-checked by CI.** Its
  `// @ts-check` + `@satisfies {SyncWorktreesConfig}` is decorative — `tsconfig.json` includes only
  `src/**/*`, eslint runs it without type information, and there is no self-link at
  `node_modules/sync-worktrees`. The example-config test covers loadability, not types.

## T32 follow-ups

- **FU-T32-1 (real bug, pre-existing, worth its own task).** `resolveRepositoryConfig` spreads
  `undefined` over inherited values. A repository entry written as
  `parallelism: { maxStatusChecks: Number(process.env.X) || undefined }` survives the spread as a
  PRESENT key whose value is `undefined`, so the runner's `?? DEFAULT` drops that repo back to the
  BUILT-IN 20 rather than the inherited global value. Demonstrated: with
  `{ maxRepositories: 30, maxStatusChecks: 1, ... }` the guard computes 30 while the run would
  actually spawn 600. `parseParallelismConfig` skips `undefined` keys, so the new merged guard
  cannot see it either. The identical hole exists for the `retry` merge. Present in the base tree;
  T32 neither introduced nor widened it. This is the same falsy/absent-value class as the T33
  finding.
- **FU-T32-2.** The phase model over-counts clone-mode repositories: `CloneSyncService` reads no
  parallelism at all, yet a clone-mode entry is weighed at its `maxStatusChecks`. Pre-existing (the
  old global-level check did the same), now extended to repository blocks.
- **FU-T32-3.** `buildRepositories(path, { filter })` filters AFTER load, so the safe-total guard
  can refuse a whole file over repositories a filtered run would never sync. Pre-existing property
  of the old check, inherited by the new one. Conservative rather than wrong, but surprising.
- **FU-T32-4.** `maxRepositories` precedence differs between two code paths: `src/index.ts:58-62`
  reads it global-first, `resolveRepositoryConfig` merges defaults-first. Harmless today only
  because nothing consumes `repo.parallelism.maxRepositories`; if anything ever does, the two
  disagree. T32 matched the runtime (global-first) and pinned it with a test.
- **FU-T32-5 (packaging, follows FU-BUILD-1).** Source growth is roughly TRIPLED in the tarball:
  the loader is bundled into two entry points, AND `tsc` copies JSDoc into the `.d.ts` even for
  `private` members whose signatures are elided (`private parseParallelismConfig;` preceded by 17
  lines of JSDoc no consumer can reference). T32's 5,331 source bytes became 12,773 shipped bytes.
  Stripping private-member JSDoc from the emitted declarations is the cheapest headroom to reclaim
  if the 1,540,000 ceiling ever tightens. Headroom now 95,390 bytes.

## T34 follow-ups

- **FU-T34-1 (test-infrastructure landmine, worth fixing).** The pre-existing `Config Generator`
  describe block still does `fs.mkdtemp(path.join(process.cwd(), ...))` — INSIDE the repo — so every
  `.js` fixture there silently inherits this package's own `"type": "module"`. That is precisely
  what hid the whole T34 bug class from the suite, including an existing "round-trip" test that
  passed for entirely the wrong reason. T34 routed its new block around it but left the trap in
  place. Move them under `os.tmpdir()`.
- **FU-T34-2 (vitest does not reproduce Node's module resolution — remember this).** Under vitest,
  `import()` goes through Vite's pipeline and returns OK for EVERY case real Node rejects: a `.js`
  with `export default` in a `"type":"commonjs"` package, a malformed `package.json`, AND a `.cjs`
  with `export default`. Only `createRequire` is not intercepted. So any future test asserting "the
  generated config loads" must spawn a real `node` child process; an in-process assertion is
  vacuous exactly where it matters most.
- **FU-T34-3. Clone mode equal to the config dir should probably REJECT, not warn.** The config
  file is written into that directory moments later, so `git clone`'s non-empty-destination check is
  guaranteed to trip. And because a clone-mode entry has no `bareRepoDir`, the new round-trip check
  passes, so `init` still prints `✅ Configuration saved` and exits 0 — the identical defect shape
  T34 exists to remove, one prompt over. Left as a warning because rejecting widens the
  "newly refuses previously-accepted input" surface; it is a maintainer call.
- **FU-T34-4. The wizard's reject is narrower than the failure class it describes.** It fires only
  on exact equality with the config dir. Answering `..` or `./.bare` also puts the default
  `bareRepoDir` inside `worktreeDir`. The round-trip backstop catches both with exit 1, so nothing
  ships broken, but the user loses every answer they typed instead of getting an inline re-prompt.
  Same asymmetry for the clone-mode warning.
- **FU-T34-5. The module-syntax hint's first clause is wrong advice for the case it fires on most
  visibly.** For `bad.cjs` it says `add "type": "module" to the nearest package.json`, which does
  nothing for a `.cjs` file. The trailing `a .cjs config must use module.exports` rescues it, but
  the order buries the applicable half.
- **FU-T34-6.** The combination `?t=` cache-buster + CJS body + `import()` — which is what a `.js`
  config in a `"type":"commonjs"` package actually hits in `loadConfigFile` — works on Node 22 and
  24 but is never exercised by a real Node process in CI (the child-process helper omits the query
  param).
- **FU-T34-7.** `src/index.ts` is excluded from coverage in `vitest.config.ts`, so `runInit` — which
  now carries real control flow including the round-trip check — contributes nothing to the
  thresholds. The new test does run it; the exclusion just means a regression there will not show up
  as a coverage drop.
- **FU-T34-8.** `toConfigRelativePath` still returns `"./"` for equal directories. T34 fixed the
  three ways a user could reach that state rather than the serializer, since `"./"` is legitimate
  for a hand-written config. Worth deciding deliberately whether the generator should ever emit it.

## T35 follow-ups

- **FU-T35-1. No reload timeout.** A config that awaits a live handle (`await new Promise(r =>
  setTimeout(r, 600000))`) hangs the reload permanently — the reviewer had to SIGKILL. NOT a
  regression (the same config hung the main thread before), and Node's unsettled-top-level-await
  detector rescues the handle-free case with exit code 13 → clean rejection. But the worker path is
  where a timeout would now be cheap to add.
- **FU-T35-2. A symlinked config path defeats the reload registry.** The key is `path.resolve()`,
  which normalizes `.`/`..` but does not resolve symlinks, so reaching the same config through a
  link counts as a fresh first load and its imported children stay stale. Degrades to the pre-fix
  behaviour, never worse. `fs.realpath` would close it.
- **FU-T35-3. A `.cjs` config that `require()`s an ESM sibling still reloads stale** (possible since
  Node 22.12's `require(esm)`; such a module lives in the ESM registry, which
  `clearRequireCacheSubtree` misses). Confirmed on Node 22 and 24. Deliberately left: routing `.cjs`
  through the worker means `import()` instead of `require()`, and the reviewer proved the shapes
  diverge for a transpiled `.cjs` doing `exports.default = config` — `require()` + `.default ?? mod`
  gives the config, `import()` + `.default` gives a wrapper. Real regression risk for a much more
  common shape.
- **FU-T35-4. `error.code` is not pinned by any test** though `src/mcp/utils.ts:61` reads it.
  Dropping the code carry-over from the worker's error rebuild survives the suite.
- **FU-T35-5. The `data:` URL vs `eval:true` hardening is untested for Node 22.0-22.11**, which
  `engines: ">=22.0.0"` admits. Under `--no-experimental-detect-module` (which simulates that
  window) the `eval:true` form fails from every cwd; a test running the child with that flag would
  pin it.
- **FU-T35-6 (side effect worth knowing).** With the reload registry live, **46 worker threads now
  spawn across a full suite run**, because pre-existing tests that load the same path twice silently
  switched to the worker path — including 3 real-Node `import()`s of the shipped
  `sync-worktrees.config.example.js`. All pass, but those tests now exercise a different evaluation
  mechanism than they used to.
- **FU-T35-7.** `src/mcp/__tests__/server.test.ts:184` builds into
  `fs.mkdtemp(path.join(process.cwd(), ".mcp-stdio-test-"))` — a temp dir INSIDE the repo, the same
  pattern flagged in FU-T34-1. Harmless in itself but leaves a directory in the worktree if the test
  crashes.
- **Correction to the TODO's own text**: MCP does NOT go through `buildRepositories`.
  `RepositoryContext.loadConfig` calls `loadConfigFile` directly (`src/mcp/context.ts:195`). Both
  paths inherit the fix because it lives in `loadConfigFile`, but the acceptance criterion as
  written was wrong.
- **Useful measurement for future size work**: esbuild STRIPS JSDoc from the JS bundles, so the
  "comments triple in the tarball" worry (FU-T32-5) applies only to the emitted `.d.ts`, not to
  `dist/index.js` / `dist/mcp-server.js`.

## CORRECTION to FU-T32-5 / the "comments triple in the tarball" rule — measured definitively

Two subagents contradicted each other on this and I measured it myself. Both were right about the
comment style they happened to sample, and both generalized wrongly. `esbuild.config.js` sets no
`minify` and no `legalComments`, and the real behaviour splits by comment SYNTAX:

  - `/** ... */` JSDoc blocks  -> STRIPPED from dist/index.js and dist/mcp-server.js,
                                  KEPT in the emitted .d.ts (even on `private` members).
                                  Net cost ~1x the source bytes.
  - `// ...` line comments     -> PRESERVED VERBATIM in BOTH bundles, absent from the .d.ts.
                                  Net cost ~2x the source bytes.

Verified by sampling six of each from `config-loader.service.ts` against the built bundle: all six
JSDoc lines absent, all six `//` lines present. This also explains the T91 worker's measurement
exactly (+4,255 to each bundle from its line comments, +2,507 to the .d.ts from its JSDoc).

So NEITHER "esbuild strips the JSDoc so comments are free" (T35 review) NOR "comments ship verbatim
and cost 3x" (T91 worker) is correct as a general rule. Practical guidance when headroom is tight:
prefer JSDoc over long `//` blocks for prose that is documentation, since JSDoc costs half as much
and lands where consumers can actually read it.

### SUPERSEDES the previous correction — the real comment-cost rule, settled by controlled experiment

My earlier correction was ALSO wrong, and so was the T91 reviewer's rebuttal. I built a minimal
probe and bundled it with esbuild directly. The rule is POSITIONAL, not syntactic:

    comment inside an OBJECT or ARRAY literal (between properties/elements) -> PRESERVED in bundle
    comment at STATEMENT level (before a declaration, or inside a function body) -> STRIPPED

...and that holds for BOTH `//` and `/** */`. Measured:

    LINE_IN_OBJECT           present
    JSDOC_IN_OBJECT          present
    LINE_IN_ARRAY            present
    JSDOC_STATEMENT_LEVEL    absent
    LINE_IN_BODY             absent

Separately, tsc copies JSDoc into the emitted `.d.ts` regardless of position, including for
`private` members.

Why the three earlier readings disagreed, all from real observations wrongly generalized:
  - My JSDoc sample was statement-level (absent). My `//` sample happened to be the parallelism
    phase table, which sits INSIDE an object literal (present). Both true, rule wrong.
  - The T35 reviewer sampled statement-level JSDoc only.
  - The T91 reviewer's "JSDoc 22/22 present in index.js" almost certainly matched validator prose
    that is ALSO a runtime error-message string literal ("must be a finite non-negative number"),
    not the comment.

Practical guidance: statement-level prose (the normal case for a function's doc block) costs ~1x and
only in the `.d.ts`. Comments interleaved in config/data literals cost ~2x, once per bundle.
The largest single cost driver in config-loader.service.ts remains JSDoc on PRIVATE methods, which
tsc copies into the `.d.ts` where no consumer can use it — still the cheapest reclaim if the
1,540,000 ceiling ever binds.

## T91 follow-ups

- **FU-T91-1 (the class, not the instance).** The blank-pattern check closes only the *blank*
  subcase of "an include list that matches nothing". `branchInclude: ["typo-branch"]` is equally
  catastrophic and still loads, as is a zero-width-space `["​"]` (Cf, not whitespace, so
  `trim()` does not touch it). Correct scoping for a loader — it cannot know which branch names
  exist — but the error message's own rationale applies to shapes still accepted. The real fix for
  the class is in the RUNNER: refuse to prune when the include filter matched zero branches.
  Worth its own task.
- **FU-T91-2. Prune with trash disabled is permanent.** Confirmed at
  `worktree-mode-sync-runner.ts:868`: when `trashService.isEnabled()` is false the runner calls
  `removeWorktree` outright, with no trash entry. The `blockedByDisabledTrash` guard does NOT cover
  this path, because `fullyPushedUpstreamDeleted` requires `recordedRefGone` and in the
  matched-nothing scenario the remote branch still exists. Any doc or audit text saying pruning is
  "recoverable within retentionDays" is wrong for `trash.enabled: false`.
- **FU-T91-3. `maxAttempts` / `maxLfsRetries` now throw two different error classes.** The legacy
  bound arm throws a plain `Error`, the new integer arm throws `ConfigValidationError`, so a caller
  catching `ConfigValidationError` to render `field`/`reason` gets it for only half the failures
  (`maxAttempts: 0` vs `maxAttempts: 0.5`). Accepted trade-off here — unifying would change pinned
  user-facing messages — but worth a consistency pass.
- **FU-T91-4. Three sources of truth for retry defaults.** `src/utils/retry.ts` `DEFAULT_OPTIONS
  .maxDelayMs = 600000`; `DEFAULT_CONFIG.RETRY.MAX_DELAY_MS = 30000`; `sync-retry-policy.ts:29-34`
  re-defaults with its own literals (3/2/1000/30000/2/0). The loader's cross-field guard compares
  against 30000 while README:380 documents `maxDelayMs: 600000`, so the README's own example is
  judged against a different ceiling than it advertises. Overlaps T61.
- **FU-T91-5. Residual rule difference, deliberately not relitigated.** `fetchTimeoutMs` /
  `cloneTimeoutMs` (T33) require safe INTEGERS for a millisecond duration, while the retry delays
  now allow finite fractions. Both defensible; unifying means picking one and refusing shapes on the
  other side.
- **Measured corrections to the record**: `retry.initialDelayMs: Infinity` and
  `backoffMultiplier: Infinity` are NOT hot loops — `Math.min(Infinity, maxDelayMs)` clamps them to
  the 30 s maximum backoff, i.e. benign. `maxDelayMs: Infinity` is the OPPOSITE failure: the cap is
  gone, so delays double without bound (days between attempts after ~20 retries). Only
  `initialDelayMs: NaN`, `maxDelayMs: NaN`, `backoffMultiplier: NaN` (from the 2nd retry) and
  `jitterMs: Infinity` floor to 1 ms. `jitterMs: NaN` is inert (`NaN > 0` is false).

### REFINEMENT to the comment-cost rule — a third placement, measured during T92

My positional rule was right but incomplete. The full picture, now measured at four placements:

  inside an object or array literal        -> 2x (both bundles), 0x .d.ts
  inside a CLASS BODY (a member's JSDoc)   -> 3x  (both bundles AND the .d.ts, including above a
                                                   `private foo;` bare name no consumer can call)
  free-standing immediately before an       -> 1x  (0x in bundles; tsc still attaches it to the
    exported class                                  class in the .d.ts)
  on any NON-EXPORTED module-level decl     -> 0x  (stripped everywhere)

So the generalization is: esbuild preserves comments inside BRACED MEMBER LISTS — object literals,
array literals and class bodies alike — and strips statement-level ones. tsc separately copies JSDoc
into the .d.ts wherever it can attach it to a declaration.

Practical consequence, and the cheapest reclaim in the codebase: **JSDoc on private class members is
paid three times and read by nobody.** Moving such prose onto a non-exported module-level
declaration (a `type` alias, say) drops it to zero shipped bytes while keeping it in the source. T92
reclaimed 3,522 bytes this way after its worker had already saved 2,368 with the earlier rule.

## T92 follow-ups

- **FU-T92-1. `NESTED_KNOWN_KEYS` is drift-guarded in only one direction.** Removing an entry is
  caught (vitest), but ADDING a new nested-object field to `Config` grows `SHARED_CONFIG_KEYS`
  (forced by the exhaustiveness assert) without forcing a corresponding `NESTED_KNOWN_KEYS` entry —
  so the new block's contents would silently go unscanned. The map is typed
  `Readonly<Record<string, readonly string[]>>`, so the test-side `Record<keyof typeof ...>` guard
  degenerates to `Record<string, ...>` and constrains nothing. The code comment now names this as
  the case to remember; a stronger type would close it.
- **FU-T92-2. The drift guards fail at `pnpm typecheck`, never under vitest.** Stated honestly in
  the changeset. `pnpm typecheck` IS a required CI step (pr.yml:81, no continue-on-error, on both
  Node legs), so this is covered — but anyone running only the test suite gets no protection.
- **FU-T92-3. Nested unknown keys are carried, not dropped.** `retry: { maxAttemptz: 5 }` rides
  through into the merged retry config because `resolveRepositoryConfig` spreads those blocks
  wholesale (and takes `sparseCheckout` by reference). Only TOP-LEVEL unknown keys are dropped by
  the allowlist construction. The "the loader drops unknown keys" mental model is wrong for nested
  blocks.
- **FU-T92-4. MCP `load_config` could return the warnings** as a `warnings: string[]` in
  `loadConfigOutputSchema`, putting them in front of the client instead of only in the server's
  stderr. Deferred because the auto-load-at-startup path would still have nowhere to put them.
- **FU-T92-5. A repository-level key written at the TOP level warns with no suggestion**, because
  the top-level candidate list has only four names. A second message arm — "'X' is not a top-level
  setting; it belongs under `defaults` or on a repository" — would be more useful.
- **FU-T92-6. Surviving mutant left alive deliberately**: `Math.min` -> `Math.max` in
  `allowedEdits`. Arguably BETTER (still blocks `nope`->`mode`, both 4 chars, while restoring
  `namess`->`name`), so the reviewer declined to lock the weaker behaviour in with a test. Worth a
  look if the suggestion heuristic is ever revisited.
- **FU-T92-7 (evidence the feature works).** On its first full-suite run the new warning found a
  dead `repoPath` key in `src/__tests__/e2e/head-branch-filter.test.ts` — a fossil from a config
  shape removed versions ago (CHANGELOG:804: "Replaced `repoPath` CLI parameter with automatic bare
  repository management"). Nothing read it. Other fixtures may carry similar fossils.
- **Corrected in the code during review**: the `allowedEdits` JSDoc claimed `name` and `mode` are
  two edits apart. They are THREE (verified independently). The test meant to pin the length gate
  therefore exercised nothing — a flat threshold of 2 left it green. The gate is really load-bearing
  for `nope` -> `mode` (two substitutions), now pinned explicitly.

## SECURITY — FU-BIN-1: `bin/sync-worktrees.js` does not redact secrets

Found during T93, and it corrects a claim I made myself. The bin shim is 11 lines:

    await main().catch((error) => {
      console.error("❌ Unhandled error:", error);
      process.exit(1);
    });

No `redactSecretsInText`. It hands the raw value to `util.inspect`, which for a simple-git failure
prints `task.commands` INCLUDING THE REMOTE URL — so a repository URL carrying an embedded token is
printed in full on any unhandled error.

The redacting handler does exist at `src/index.ts:655`, but it is guarded by `isMainEntrypoint()`,
which is FALSE when the CLI runs through the bin shim. So the unredacting handler is the one that
actually fires in normal use. Verified by reading both files.

T93 deliberately did NOT widen what reaches this handler (and its trash change strictly reduces it),
so nothing regressed — but the gap is live and independent of T93. Fixing it needs
`redactSecretsInText` reachable from `dist/index.js`.

Related, and FIXED by T93: `runList` and `runSync`'s load catch previously printed
`(error as Error).message` raw, leaking a tokenised URL named in a config error. Both now redact.

## T93 follow-ups

- **FU-T93-1 (first follow-up; same defect, same release).** `sync-worktrees init` still prints
  `❌ Unhandled error: ExitPromptError` + 5 frames through the UNREDACTING bin handler when the user
  presses Ctrl+C at a prompt. Reproduced under a real pty on the final build. T93 fixed exactly this
  for `trash`, so the release note now says "Ctrl+C at a trash confirmation prompt is one line"
  while the sibling command in the same release still prints ten. No leak (ExitPromptError carries
  no URL) and exit code already 1, so it is cosmetic — but the fix is three characters of reuse.
- **FU-T93-2.** `runInit`'s round-trip scrub is untested (mutant M18 survives). The wrap is
  defence-in-depth; the reviewer could not construct a reachable unredacted credential there,
  because `init` writes the config itself and the only load error quoting a `repoUrl` already
  redacts at source. Worth a test if someone can build the case.
- **FU-T93-3.** `configErrorLocation` can emit the same path twice — `(/p/c.cjs, at /p/c.cjs:3)`.
  Cosmetic, and less reachable after the review's parsing fix.
- **FU-T93-4 (pre-existing, unchanged).** `isExpectedTrashFailure` treats EVERY `SyncWorktreesError`
  as expected, including `GitError`/`GitOperationError`, so a genuinely corrupt repository is also
  reduced to one line. T89's design, deliberately not relitigated, but broader than "usage mistake".
- **FU-T93-5.** `InteractiveUIService.tsx:315` has T93 claim 1's defect in the TUI reload path:
  `Failed to initialize repository: ${result.reason}` with no name, although `repoConfig.name` is in
  the closure. Same fix shape; the TODO scoped claim 1 to `runMultipleRepositories`.
- **FU-T93-6.** `workerEvalError` falls back to the LOCAL stack when a config throws a non-Error
  (`throw "x"` yields `stack: undefined`), so the reported location would point at sync-worktrees'
  own bundle. Very narrow.

### Two measured facts worth reusing

- **`node --check` is NOT a usable way to locate a config syntax error.** It exits 0 and reports
  nothing when the unparseable module is one the config *imports* (measured: `cfg.mjs` importing a
  broken `dep.mjs` passes `--check` while the real import fails). So it would report "fine" for a
  failing config, or a position from a file that is not the one that failed. The worker's refusal to
  use it was more correct than it knew.
- **Under Vitest, a config load failure reports a position INSIDE VITE'S OWN BUNDLE.** A probe
  loading an unparseable `.mjs` through the real `ConfigLoaderService` under Vitest produced
  `Failed to parse source for import analysis ... at .../vite/dist/node/chunks/node.js:30375:39`.
  A unit test would have pinned Vite's message AND a line number in Vite's bundle. Anything
  asserting on config-load error text must run in a real `node` child process.

## T94 + T96 follow-ups

- **FU-T94-1. `trash --filter`'s `-f` alias is unpinned** — deleting it fails no test (same for
  `list`). The README's new text does not claim short aliases for `trash`, so nothing is
  contradicted, but the alias could vanish silently.
- **FU-T94-2. `repo.branch = branch.trim()` is unpinned** — removing the trim survives. Whitespace
  in a branch name would fail at git anyway, so the code is correct but untested.
- **FU-T94-3.** The init URL validator still calls `safeRepoName(value)` on the RAW string. Harmless
  only because `extractRepoNameFromUrl` trims internally. Inconsistent with the two sibling checks
  in the same validator, which now read `value.trim()`.
- **FU-T94-4.** `trash --wait` on a bare listing parses and does nothing — no `.conflicts()` against
  the no-op listing, and `lockWaitMs` is read only by restore/purge. Harmless; the README wording
  deliberately avoids over-promising ("applies to --restore and --purge" rather than "is only valid
  with").
- **FU-T96-1.** `worktreeDir === configDir` still has no generator round-trip test. Deliberately
  skipped: the audit's own acceptance criteria name only the `.cjs` target and the
  `"type": "commonjs"` package, the wizard now rejects that answer in worktree mode and warns in
  clone mode, and the shape was verified not silently broken (`toConfigRelativePath` emits `"./"`;
  clone mode resolves to the config dir and `list` exits 0; worktree mode is rejected loudly as an
  overlap).
- **FU-T96-2.** `vitest.config.ts` excludes `src/index.ts` AND `src/utils/cli.ts` from coverage, so
  the new daemon and CLI tests are guards rather than coverage movers — a regression in either file
  will not show up as a coverage drop. Confirmed empirically: the coverage summary is identical to
  the digit before and after adding them.

### Measured facts worth reusing

- **`node-cron`'s `validate` tolerates only the ASCII space.** Tab, NBSP, CR, LF, VT, FF, en-space,
  narrow-NBSP, ideographic space and BOM all make it return false, while `String.trim()` removes all
  of them. So any padded-but-not-space cron answer is accepted by a `validate(value.trim())` prompt
  and then rejected by the loader — the wizard writes a config and its own round-trip check refuses
  it. This is the shape pasting a schedule out of rendered docs produces.
- **A vitest harness can report every mutant as KILLED for the wrong reason.** The reviewer's first
  batch passed `--reporter=basic`, which vitest 4 removed, so the runner exited 1 unconditionally
  and every mutant looked caught — including a known equivalent one. Fix: use the default reporter
  and put an INERT CONTROL MUTANT (a comment change) in every batch; if the control does not
  SURVIVE, the harness is lying. Worth adopting as standing practice.

### CORRECTION — the NUL-byte file count is 1, not 25

The T95 worker reported 25 files under `src/` contain NUL bytes and I propagated that in a check-in.
It is WRONG. Measured myself with a Python byte scan over all 243 files under `src/`: exactly ONE
contains `\x00` — `src/services/__tests__/git.service.test.ts` (21 NULs, inside `for-each-ref -z`
fixture strings). The reviewer measured it three ways and agrees: 1 file binary-classified by grep,
2 files containing any C0/DEL byte, 0 with invalid UTF-8. Repo-wide the only other NUL files are a
GIF and a PNG.

So `grep -a` matters for exactly one source file, the one already known — earlier "zero references"
claims in this batch made without `-a` were NOT silently under-reporting across 25 files. Use `-a`
anyway; it costs nothing.

## T95 follow-ups

- **FU-T95-1. Two dead constants left deliberately**, each with production literal duplicates:
  `GIT_CONSTANTS.REMOTE_NAME` (14 `"origin"` literals across clone-sync ×8, git.service ×5,
  mcp/context ×1) and `ERROR_MESSAGES.ALREADY_REGISTERED` (3 code literals at git.service.ts
  1274/1385/1481, plus one in a prose comment). Wiring them means touching 17 production call sites
  for zero behaviour change — larger and riskier than the audit asked for. Delete-or-wire is a
  decision someone should make.
- **FU-T95-2. `retry.ts`'s `DEFAULT_OPTIONS` is a third set of retry defaults** and is only
  PARTIALLY shadowed. `SyncRetryPolicy` supplies all six numbers, so `maxAttempts: "unlimited"` and
  `maxDelayMs: 600000` are dead for the sync path — but `shouldRetry`, the whole error-classification
  predicate (LFS, ENOTFOUND/ECONNREFUSED/ETIMEDOUT, EACCES/EPERM/EROFS/ENOSPC, EBUSY, auth errors),
  is NOT supplied by the policy and runs on every retry of every sync. So `retry.ts` is not dead
  code, and a future direct caller of `retry()` would pick up its numbers too.
- **FU-T95-3. T61 is now better-founded.** `README.md:678-684` documents the retry defaults as
  `maxAttempts: "unlimited"` and `maxDelayMs: 600000` — those are `retry.ts`'s `DEFAULT_OPTIONS`,
  which `SyncRetryPolicy` shadows, so a sync actually defaults to 3 attempts / 30 s. README:376-381
  repeats the same numbers in a sample config. After T95, `DEFAULT_CONFIG.RETRY.*` is the single
  source of truth and T61 should fix README against it. Also
  `sync-worktrees.config.example.js:57` sets `maxDelayMs: 600000 // Maximum delay: 10 minutes` with
  no `(default: N)` annotation, sitting beside lines that do annotate defaults — reads as a default
  claim when it is an example value.
- **FU-T95-4. `scripts/smoke-test.mjs:45` narrative is stale**: it says "`npm pack` reports 86 files
  and ~1.26 MB unpacked"; the real figures are 90 files / 1.485 MB. The CEILINGS (120 files /
  1,540,000 bytes) are correct — only the explanatory prose drifted.
- **FU-T95-5. Four public config types are not re-exported** from `src/index.ts`:
  `SyncWorktreesMaintenanceConfig`, `SyncWorktreesCloneRepository`, `SyncWorktreesCloneDefaults`,
  `SyncWorktreesWorktreeDefaults`. The other ten `SyncWorktrees*` types are. Likely an oversight in
  the public type surface.
- **FU-T95-6. A knip / unused-exports CI gate was deliberately NOT added.** A repo-wide heuristic
  scan found ~51 unused-export candidates across 35 files (mcp/context.ts ×5, signal-handlers ×4,
  worktree-sync-planner ×3, trash.service ×3, …), none in files T95 touched — most are exported
  interfaces used only as inferred shapes, which knip's defaults flag and which are not really dead.
  Adding it now would block the PR on ~51 pre-existing findings. If wanted, it belongs in its own
  task that lands the config AND a seeded baseline together so the gate starts green.

### Useful verified mechanism

esbuild tree-shakes an unreferenced TOP-LEVEL export (that is why `TEST_TIMEOUT` shipped only as a
`.d.ts` declaration and appeared in neither bundle), but it CANNOT shake an unused MEMBER of an
object the bundles reference — those shipped in the bundles at 1-3 occurrences each. So dead
constants cost real bytes when they hang off a live object, and nothing when they stand alone.

## T79 follow-ups

- **FU-T79-1. The unification is still incomplete — there is a FOURTH URL grammar.**
  `src/utils/interactive.ts:39` validates the init wizard's `repoUrl` with its own
  `/^(https?:\/\/|ssh:\/\/|git@|file:\/\/).*$/`. It is strictly narrower than the shared grammar, so
  it cannot write an unloadable config (and T34's round-trip load backstops it), but it REFUSES
  `git://…`, `deploy@host:org/repo.git` and absolute local paths — two of the three shapes T79's
  headline newly allows. It also refuses a path-less host URL via `safeRepoName`, so
  `sync-worktrees init` cannot produce the web-root config the loader now accepts. Folding it onto
  `parseGitUrl` is the obvious finish.
- **FU-T79-2.** `isDuplicateRepoUrl` (`config-loader.service.ts:1460`) compares `repoUrl` with raw
  `===` while the origin-mismatch check uses `normalizeRepoUrlForComparison`, so
  `https://h/r.git` and `https://h/r` are duplicates for one and not the other.
- **FU-T79-3 (documented, deliberate).** IPv6 scp remotes change their derived directory:
  `git@[2001:db8::1]:repo.git` now yields `.bare/repo` instead of `.bare/db8::1]:repo`. Measured:
  `mkdir '.bare/db8::1]:repo'` SUCCEEDS on Linux and git really dials that remote, so this is a real
  re-clone for anyone on that spelling, not a theoretical one. Stated in bold in the changeset with
  `bareRepoDir` named as the way to keep the existing clone.
- **FU-T79-4 (bug-for-bug preservations, deliberate).** `/srv/project/.git` still resolves to
  `.bare/` (empty derived name), and URL-derived names are still unsanitised (`repo?x=1` becomes a
  directory name; `sanitizeNameForPath` is applied to the config `name` but never to the URL-derived
  one). Both preserved because changing either moves an existing `.bare/<name>` — the exact harm
  under review. Each deserves its own task with a migration note.
- **FU-T79-5.** `git+ssh://` is refused by both halves of the grammar although git accepts it and
  `redactRepoUrl` has tests for it. Consistent, so out of T79's scope, but a real gap; adding it is
  one entry in the scheme set.

### Method worth reusing

The T79 review replaced a generated corpus with EXHAUSTIVE enumeration — 11.1M character-level
strings over a 10-symbol alphabet at length <= 7, plus 3.4M token-level strings at depth <= 5 —
after recompiling BOTH the base and head modules with esbuild rather than transcribing them. That
turned "36 URLs change" (a property of one corpus, not reproducible) into four falsifiable
divergence CLASSES. When a change rewrites a grammar, enumerate the language rather than sampling it.

Also: a mutation harness needs a `tsc --noEmit` gate in front of it. On T79 a mutant broke type
narrowing (`TS2345`) and would otherwise have been scored a kill; on an earlier task, markers landing
inside regex literals broke the file syntactically so vitest reported "no tests" and every file
failed — a false KILLED across the board.

## T80 follow-ups

- **FU-T80-1. `include: ["."]` loads, works, and never settles.** git accepts `.` (rc 0) but
  `sparse-checkout list` then returns EMPTY, so `readCurrent` -> null -> `needsUpdate` -> true on
  every tick, forever, materialising nothing. Pre-existing. A warning (not a rejection — git accepts
  it) would be the right treatment.
- **FU-T80-2. Backslash directories re-apply every tick.** `apps\web` is accepted by git, but
  `sparse-checkout list` echoes it C-quoted as `"apps\\web"` even under `core.quotePath=false`, so
  `patternsEqual` can never match and the patterns are rewritten on every tick. Pre-existing; the
  `readCurrent` comment acknowledges the quoting but not this consequence.
- **FU-T80-3. Loader-level test gap.** `coneViolations.join(" ")` -> `coneViolations[0]` in the
  loader SURVIVES the suite: the "reports every offending entry" property is tested on
  `findConeRuleViolations` directly but never through `ConfigLoaderService`, so the load error could
  silently drop all but the first bad entry with nothing noticing. Message-completeness, not
  correctness.
- **FU-T80-4. Two cosmetic survivors in the message builder**: `written.trim() === applied` ->
  `written === applied` (the whitespace test asserts only `toContain`, so a spurious
  "(applied as ...)" still passes), and `if (!asWritten.has(applied))` -> always set (changes which
  raw entry gets quoted when several collapse to one canonical form).
- **FU-T80-5 (env caveat, NOT attributable to this branch).** 15 e2e tests fail under the
  locally-built git 2.55 — default-branch-rename, locked-worktree-prune, force-clean-*,
  trash-restore-after-gc, no-upstream-worktree-update, uninitialized-submodule-prune,
  auth-prompt-disabled, clone-branch-wizard, skip-lfs-global-ignore. The SAME 15 fail on the base
  tree under the same binary, and none touch sparse-checkout. Most likely artifacts of the minimal
  build (NO_CURL / NO_PERL / no templates / no dashed `git-*` helpers installed) rather than real
  2.55 behaviour, since CI passes on 2.55. Flagged rather than claimed — but if CI ever goes red on
  one of these, this is the first thing to re-check with a full 2.55 install.

### Two measured facts worth reusing

- **`git sparse-checkout check-rules` is NOT a validator.** On both 2.43 and 2.55 it returns rc 0
  for `/apps/web`, `apps/*`, `!apps` and `apps\web`, and rc 128 only for `..` / `apps/../..`. It
  runs the normalization check and none of the leading-slash, `!` or glob checks. The TODO proposed
  it as an oracle; it does not work as one.
- **git 2.43 -> 2.55 dropped `PARSE_OPT_KEEP_UNKNOWN_OPT`** for `sparse-checkout set`/`add`
  (2.43 `builtin/sparse-checkout.c:781,828` vs 2.55 `:872-874`). Without a `--` separator a
  dash-leading include is parsed as an option: on 2.55 that is a hard `unknown switch` failure (53
  shapes in a 2,000-case fuzz were the ONLY 2.43-vs-2.55 disagreements), and on BOTH versions an
  include literally named `--skip-checks` is swallowed as the flag — I verified this myself: the
  sparse set ends up empty, git returns rc 0, and the run reports success while checking out
  nothing. `--cone` / `--no-cone` as directory names silently flip the mode the same way. Fixed in
  T80 by passing `--`.

## From T61 (retry docs) — reviewer, 2026-09-16

- **FU-RETRY-1 (the significant one).** `GitService.initialize()` does an unconditional
  `fetch --all --progress` (`git.service.ts:360-362`) that runs OUTSIDE `retry()`, so no
  `retry.*` setting ever applies to it. `isInitialized()` is an in-process flag
  (`this.git !== null`, `:673-675`), not a filesystem check, so every fresh process pays
  it, and both `src/index.ts` (runOnce) and `InteractiveUIService.runSyncServices` call
  `initialize()` BEFORE the `retry(...)` wrapper. Measured against the built CLI with an
  already-initialised bare repo and a broken remote: `EXIT=1 elapsed_ms=522`, zero
  "Sync attempt N failed" lines — one attempt, not three. The error it dies on
  (`Could not read from remote repository`) is the FIRST ITEM on the README's retried
  list. A long-lived daemon pays this once per repo; a crontab-driven
  `sync-worktrees --runOnce` pays it on EVERY run. Pre-existing (the old README had the
  same gap) and the new prose is literally defensible — it says "a failed sync *attempt*",
  and the initialize fetch is not one — so T61 correctly did not paper over it in docs.
  The fix belongs in code: wrap `initialize()` in the same policy.
- **FU-RETRY-2.** `retry.ts`'s `ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT` branches test
  `err.code`, which no git SUBPROCESS error carries, so those three branches are likely
  unreachable in production. Real git DNS failures arrive as
  `fatal: unable to access ... Could not resolve host` and are retried via the message
  pattern instead. Dead-ish code that reads as the primary network-error handling.
- **FU-RETRY-3.** `sync-worktrees.config.example.js:53-60` annotates `maxLfsRetries` and
  `jitterMs` with "(default: N)" but leaves `maxAttempts: "unlimited"` and
  `maxDelayMs: 600000` unannotated, so one file mixes two shipped defaults with two
  non-defaults under one convention. No false claim, but it is where T61's trap still lives.
- **FU-RETRY-4.** `src/utils/retry.ts:33` `DEFAULT_OPTIONS` keeps `maxAttempts: "unlimited"`
  and `maxDelayMs: 600000` — values no shipped code path uses, reachable only by a direct
  `retry()` caller passing no options. They are what the README used to document.
- **FU-RETRY-5 (cosmetic).** `.changeset/t91-load-time-validation-gaps.md:16` still says
  "(What the built-in default is, and what the README says it is, is a separate matter and
  unchanged here.)" — harmless, but it now describes a gap T61 closed.
- **FU-FMT-1 (process, not a bug).** `pnpm format:check` is NO evidence about any `.md`
  diff: `.prettierignore` excludes `*.md` wholesale ("Markdown is hand-wrapped"). Markdown
  table alignment has to be measured by cell width, and note that U+2014 costs 3 bytes but
  1 column, so a byte-oriented diff view shows false misalignment.

## From T36 (syncOnStart) — reviewer, 2026-09-16

- **FU-TUI-1.** `handleReload` calls `runSyncServices` directly and so does NOT take
  the new one-cycle-at-a-time gate: a cron tick landing inside a reload's sync still
  overlaps it. `waitForInProgressSyncs` covers the common case but gives up after 30 s
  and proceeds "with potential data loss risk".
- **FU-TUI-2.** `InteractiveUIService.runSyncServices` still calls
  `service.clearRecordedSkips()` from the caller side, outside the repo lock. T36's
  gate hides it from the cron path, but the call is in the wrong place relative to the
  invariant `worktree-sync.service.ts:731-734` documents in its own comment
  ("a losing concurrent caller clearing the shared accumulator would silently truncate
  the winner's skips payload"). Move it, or drop it.
- **FU-TUI-3.** `waitForInProgressSyncs` polls at a fixed 500 ms and caps at 30 s —
  short for a large first sync now that one runs on every daemon start.
- **FU-TUI-4.** `InteractiveUIService`'s constructor does
  `setTimeout(() => this.addLog("🚀 sync-worktrees UI initialized"), 100)` — a 100 ms
  delay whose stated purpose ("verify the pipeline works") no longer matches the code.
- **FU-TEST-1.** 5 tests are skipped suite-wide. Pre-existing, never inspected. Worth
  one pass to confirm none is skipped around a real defect.

## Byte-budget intelligence (measured, 2026-09-16) — AFFECTS EVERY REMAINING TASK

Ceiling 1,540,000 bytes / 120 files, enforced by `pnpm smoke`, so a breach is a hard
CI failure, not a warning. At b6fdd6c: 90 files / **1,496,735 bytes → 43,265 left**.

Per-task deltas, measured by building each of the nine preceding audit commits:
fb59e30 +9,356 · aa7dff8 +22,262 · b032b0e +3,366 · 900ba86 +1,706 · 4cea14c **−249**
· 95d6d9b +4,755 · a243000 +2,696 · 69be277 +2,031 · T36 +2,221.
Trimmed mean (dropping the two docs-heavy outliers) **≈2,360 B/task**; median 2,696.

**Available is 43,265 / 32 remaining = 1,352 B/task — a little over half the
historical rate.** At the observed rate the ceiling is hit after ~16-18 more tasks,
with ~35 kB of overrun by the end. Levers, largest first:
  (a) README is ~37% of a typical task's cost and is the only shipped file where
      prose is optional;
  (b) JSDoc on a member of an *internal* exported interface is copied into the
      `.d.ts` — make it a `//` line comment and it is free. `dist/types/index.d.ts`
      is 24 kB of shipped surface. Keep JSDoc only on the public `SyncWorktrees*`
      input types, which is what a config author's editor actually reads;
  (c) anything touching `config-loader.service.ts` or `src/utils/` is billed TWICE,
      once into `dist/index.js` and again into `dist/mcp-server.js`;
  (d) statement-level comments in `src/` are free — esbuild strips them all.
`4cea14c` (−249) proves a refactor task can return bytes.
**Decision needed before ~task 17, not as a surprise failure at it:** raising the
ceiling constant in `scripts/smoke-test.mjs` is legitimate, but only after the fat is
out, and it should be its own commit with a stated rationale, never folded into a task.

## From T39 (strict MCP tool inputs) — 2026-09-16

- **FU-MCP-1.** `src/mcp/output-schemas.ts` uses `z.looseObject` throughout, so tool
  **outputs** stay loose. Server→client, so it silently STRIPS fields from responses
  rather than admitting unknown ones — a smaller failure than T39's, but the same
  class, and T39's decision did not cover it.
- **FU-MCP-2.** `src/mcp/__tests__/server.test.ts:231` creates its esbuild temp dir
  under `process.cwd()` (`.mcp-stdio-test-*`), inside the repo working tree, rather
  than `os.tmpdir()` like every other fixture in the file.
- **FU-MCP-3.** The stdio test's `request()` helper has a fixed 5s timeout and its
  `startServer` closure is re-declared per test; a shared helper would let more tests
  reuse the real transport cheaply.

### Corrected standing rule — WHICH SUITES NEED A PRIOR `pnpm build`

I had been telling every worker "rebuild before scoring an e2e kill, because e2e run
`dist/`". That is only half true, and it cuts both ways. Proven by execution (mutate
`dist/mcp-server.js` only, leave `src/` pristine, run each suite):

| Suite | Needs a prior `pnpm build`? | Why |
|---|---|---|
| `src/mcp/__tests__/server.test.ts` (incl. its stdio test) | **No** | esbuilds `src/mcp/index.ts` into a fresh temp bundle at test time (`:231-245`) |
| all other `src/**/__tests__/*` | **No** | import `src/` through vite |
| `src/__tests__/e2e/*` | **Yes** | four files hardcode `../../../dist/index.js` |
| `pnpm smoke` | **Yes** | drives `bin/`, `dist/index.js`, `dist/mcp-server.js`, `npm pack` |

Corollaries: for e2e and smoke, a `src/` mutant that is NOT rebuilt scores a false
SURVIVED. For everything else, rebuilding is wasted time — and worse, building HIDES
a `dist`-only mutant. Brief the rule per suite, never as a blanket.

### Semver precedent is NOT uniform — know this before arguing a bump

The repo's stated line (verbatim in `t92`'s changeset): *"This warns and refuses
nothing … which is why this is a patch rather than a minor."* `t80`, `t91`, `t32` are
`minor` and all refuse input that previously loaded. **But `t40` is `patch`** and also
refuses something that previously succeeded, on the MCP surface — and `t38` (MCP) is
`patch` too. Branch-wide: 10 `minor`, 73 `patch`; every other MCP changeset is `patch`.
T39 was still scored `minor` because it refuses a whole class of inputs across all
nine tools AND changes the advertised wire schema (`additionalProperties: false`)
that clients cache — the `t80`/`t91`/`t32` shape, not `t40`'s single narrow case.

## From T37 (create_worktree branch filters) — 2026-09-16

- **FU-MCP-4.** `getBranchWorktreePath` hashes EVERY branch name (`trunk` →
  `trunk-3e341d2d`) while the anchor worktree is created at the plain
  `worktreeDir/<defaultBranch>`. So `create_worktree {branchName: <defaultBranch>}`
  targets a non-existent path, skips the `TARGET_EXISTS` check, and surfaces git's raw
  `fatal: 'main' is already used by worktree at ...` as `INTERNAL_ERROR`. Pre-existing.
- **FU-MCP-5.** The MCP surface still exposes no trash restore, so anything prune takes
  (forced, or local-only) is recoverable only via the CLI. This is what makes T37's
  `push: false` protection a warning rather than a guarantee. Proposed middle path,
  filed not implemented: mark MCP-created local-only worktrees in the sync metadata and
  have `planPruneActions` skip a worktree that has no `origin/<branch>`, was created
  that way, and is younger than a grace window. Bounded; does not touch ordinary prune.
- **FU-MCP-6.** `handleUpdateWorktree` / `handleGetWorktreeStatus` have no equivalent
  guard — correct today, since they act on registered worktrees — but after a prune they
  fail with "not a registered worktree" and no hint that a prune is what happened.
- **FU-MCP-7.** T37's guard is stricter than the runner in one narrow window: between an
  origin-side default-branch rename and the next sync, `getDefaultBranch()` returns a
  stale cached string, so the NEW default is refused while the runner would retain it.
  Fails closed, `force: true` opens it, one sync heals it. Documented in a comment.
- **FU-MCP-8.** The local-only warning says "until it is pushed", but committing into the
  worktree also protects it (`canRemove` sees unpushed commits). Over-warns safely.
- **FU-CFG-1.** `filterBranchesByAge` warns about an invalid `branchMaxAge` via bare
  `console.warn` rather than the injected logger, and an invalid duration string
  SILENTLY disables the age filter in both the runner and the new guard. Load-time
  validation covers `branchInclude`/`branchExclude` patterns but not the duration format.

### Byte facts corrected by measurement (supersede earlier guesses)

- **Source comments cost ZERO in the bundles, all of them.** esbuild re-prints the AST,
  so no comment survives into `dist/*.js` — the earlier "comments inside braced member
  lists ship ~2x" rule does NOT hold for this repo's bundles. What DOES cost is types:
  `output-schemas.d.ts` grew 41 bytes because `warning: z.ZodOptional<z.ZodString>;` is
  emitted TWICE. The 2x is structural, not comments.
- **Tests, changesets and CHANGELOG.md all cost ZERO** — `package.json#files` is
  `bin, dist, README.md, LICENSE`. CHANGELOG.md is 64,239 bytes on disk and absent from
  the tarball. A 10 kB changeset is free; write the reasoning there, not in the README.
- Only `dist/*.js`, the `.d.ts` files and `README.md` cost anything.
- The two largest non-bundle tarball entries, if a later task needs headroom:
  `dist/types/index.d.ts` (23,865 B) and `dist/utils/git-env.d.ts` (13,644 B).
- Rule of thumb from T37: a bundle delta is ~45 bytes per line of shipped code.

### Two new standing rules from T37's review

- **`grep -c` counts matching LINES, never occurrences, and a multi-line `-F` pattern is
  silently treated as an OR of its lines.** Demonstrated: on a 3-line file
  `alpha/beta/alpha`, `grep -cF 'alpha'` → 2 and `grep -cF $'alpha\nbeta'` → 3.
  Use a SINGLE-LINE marker and count with `grep -oF <marker> <file> | wc -l`.
- **Never point a scratch vitest `include` at the shared scratchpad** — it contains a
  full copy of this repo under `base/`, and `src/__tests__/e2e/*` fixtures MUTATE the
  checkout they run in. A reviewer did this and created `tmp-e2e-clone-mode/`, two local
  branches and five empty commits in the working repository. Anything that can reach the
  e2e fixtures must be run deliberately by path, never by glob.

## From T103 (.ts configs, Node 24 floor) — 2026-09-16

- **FU-NODE-1 — RESOLVED 2026-09-16, no action needed.** Measured after the merge: CI on 53515fb
  ran 4 checks (the Node 22 leg gone, Node 24 present) and PR #114 still reports
  `mergeable_state: "clean"`. No branch-protection rule names the deleted check. Original note: Branch protection on `main` may still
  require a status check literally named `Lint, Type Check & Test (Node 22)`. That leg no
  longer exists, so if the requirement is configured, every PR sits un-mergeable forever.
  Unverifiable from the container (`gh` absent, and paginating `list_branches` for `main`
  is slow); the definitive test is `mergeable_state` on PR #114 after the first CI run
  following the merge — `clean` means no such requirement, `blocked` means it exists and
  must be retired in repo settings.
- **FU-NODE-2.** `TODO.md:4519` — completed task **T119**'s acceptance is literally "pr.yml
  runs the test job on Node 22 and Node 24". T103 deletes that leg. T119's *intent* (CI must
  test the floor) is preserved because the floor is now 24, but the literal acceptance of a
  finished audit task is reversed and neither commit nor changeset mentions T119.
- **FU-NODE-3.** `src/utils/cli.ts:43,89,112` — `--config` help says "Path to JavaScript
  config file" in three duplicated strings; it now also accepts `.ts`.
- **FU-NODE-4.** `@types/node` (`^26.1.2`) is not pinned to the engines floor. Measured today:
  0 declared-but-absent exports against Node 24 (it was 8 against Node 22, so the floor raise
  *improved* this), but nothing structurally stops the gap reopening.
- **FU-NODE-5.** `esbuild target: "node22"` now sits below the floor. Harmless and deliberate
  (a downlevel target runs on 24), but someone should decide whether it tracks `engines`.
- **FU-TEST-2.** `makeCtx` in `handlers.test.ts` still has `detectFromPath: opts.discovered ??
  makeDiscovered()`. Inert — production `detectFromPath` returns a non-nullable type — but
  asymmetric with the `getDiscoveredContext` fixed beside it, driven by the same option, which
  is exactly how the original bug got in.
- **FU-TEST-3.** `ctx.getCurrentRepo() ?? "current repository"` in the new `list_worktrees`
  error is unreachable from handler tests, because `makeCtx` types `currentRepo?: string` and
  cannot express a `null` return.

### THE `?? default` TEST-HELPER TRAP — rule, and the audit of this repo's helpers

A `?? default` in a test helper is SAFE **iff the default is itself the falsy value**
(`syncInProgress ?? false`, `configPath ?? null`, `names ?? []`) — then passing the falsy
value explicitly is indistinguishable from omitting it. It is a TRAP whenever the option's
type admits `null`/`false`/`0` AND the default is something else: the helper silently
substitutes, the test exercises the opposite branch, and its name describes a state its own
mock makes impossible. That is exactly how `list_worktrees`' error path went untested —
`opts.discovered ?? makeDiscovered()` replaced an intentional `null` with a full context, so
reverting the error message passed 107/107 against the pre-fix test file.
Audited every `??` in the MCP helpers: the only type-unsafe site left is `detectFromPath`
(inert, above). **Correction to an earlier claim: `baseCapabilities` was NEVER unsafe** — it
already read `=== undefined ? … : …` before this task. Use `=== undefined`, not `??`.

### THE COMMENT-COST RULE — settled by controlled experiment. I had it wrong three times.

Compiled one probe containing all six comment forms through `tsc --emitDeclarationOnly` and
esbuild with this repo's exact options.

**To `dist/**/*.d.ts` (the ONLY place a comment ever costs bytes):** the declaration emitter
copies **block comments beginning `/**` or `/*!`** — JSDoc and pinned comments — **verbatim,
every line**, when they lead a declaration that is itself emitted (an exported
const/function/class/type/interface, or a member of an emitted type). Multiple leading such
comments are all kept. It copies **nothing else**: `//` and plain `/* … */` are dropped
unconditionally. JSDoc on a **non-exported** declaration costs nothing — the declaration is
not emitted.

**To `dist/index.js` and `dist/mcp-server.js` (esbuild, minify off):** **no source comment of
any form survives.** The sole exception is legal comments (`/*!`, `//!`, `@license`,
`@preserve`), which `legalComments: "eof"` MOVES to the end of the file.

**Therefore:** `//` is free everywhere. Plain `/* … */` is free everywhere. `/** … */` is free
UNLESS it leads an exported declaration, where it ships at full length in the `.d.ts`. `/*!`
and `@license`/`@preserve` are the one form billed in BOTH destinations.
Measured consequence: a 19-line JSDoc rationale on the exported `CONFIG_FILE_NAMES` cost
+1,124 bytes; the same text as `//` lines above a one-line JSDoc cost +133. Prior wrong
versions of this rule — "comments in braced member lists ship 2x" and "comments are free
wherever they sit" — are both superseded; delete them.

## From T97 (auto-detected worktreeDir) — 2026-09-16

- **FU-MCP-9.** `load_config` / `list_repositories` still surface the PLACEHOLDER `worktreeDir`
  for a detected entry whose derivation failed, while `detect_context` correctly says `null`.
  `repositoryListEntrySchema.worktreeDir` is a required `z.string()`, so reporting `null` there
  is a wire change and was left alone.
- **FU-MCP-10.** `pathsEqual` is lexical only (`path.resolve`, no `realpath`). That is exactly
  what makes the symlinked-probe case reachable — now handled rather than latent, but the
  assumption is still unasserted anywhere.
- **FU-MCP-11.** `parseWorktreeListPorcelain` never records git's `bare` marker; the bare entry
  is dropped only incidentally, because it has no `branch` line.
- **FU-MCP-12.** `getReadyService`'s `ensureInitialized` option is never passed `true` by any
  caller — dead parameter.
- **FU-MCP-13.** `GitService.initialize()` sets `mainWorktreePath` to
  `join(worktreeDir, GIT_CONSTANTS.DEFAULT_BRANCH)` as a "Temporary" value before the real
  default branch is known.
- **RESOLVED by T97, was FU:** the `cannot determine worktreeDir` reason now names a remedy
  ("set an explicit worktreeDir in a config for this repository and call load_config"), closing
  the "names the cause but no remedy" gap filed earlier.
- **Not claimed:** git 2.55.0 porcelain shape. The container has 2.43.0 only; the derivation
  reads just `worktree`/`branch`/`detached`/`bare` through the pre-existing unchanged parser.

### THE COMMENT-COST RULE — one refinement, "exported" is WIDER than it looks

`/** … */` is billed into the shipped `.d.ts` when it leads a declaration tsc EMITS — and that
includes a **non-exported type dragged in by an exported signature**. Measured: `RepoEntry` is
not exported, but `RepositoryContext.__registerForTest(name, entry: Omit<RepoEntry, "name">)` is
a public method on an exported class, so tsc emits the whole interface into
`dist/mcp/context.d.ts` and copied the JSDoc with it — **+398 bytes**. As `//` it was +39.
So: "free unless it leads an exported declaration" → "free unless it leads a declaration that
reaches the `.d.ts`, by export OR by being referenced from an exported signature."

### TWO SIGNALS, NEITHER TRUSTED ALONE — the T97 design lesson, both shapes MEASURED

Deriving `worktreeDir` from registered worktrees has two candidate signals and each fails alone:
- **Count alone (strict plurality):** two hand-placed `<dir>/<branch>` worktrees sharing a parent
  outvote a smaller managed tree → a write lands OUTSIDE `worktreeDir`. Fail-OPEN.
- **Probe alone (trust the worktree the call came from):** ONE hand-placed worktree overrides five
  managed ones whenever the agent stands in it — and standing in it is CORRELATED with the call,
  since an agent detects from the worktree it was asked to work in. Also fail-OPEN, and MORE
  reachable (one stray, any managed tree size).
Requiring both to agree has no wrong-directory shape across ten measured layouts. A tie or a
disagreement refuses with an actionable remedy. Where the probe is unusable — a symlinked cwd
loses it because `isCurrent` is lexical while git stores canonical paths, and a detached worktree
abstains — it falls back to the count alone.
**Process note:** this took three send-backs. The plurality fail-open and the probe fail-open were
each only findable by BUILDING the rule and pointing real git at it through real MCP stdio. When a
reviewer offers a rule in a parenthetical, make it measure the rule before adopting it — I adopted
probe-first on its parenthetical and it was wrong in a shape neither of us had considered.

## *** THE COMMENT-COST RULE — DEFINITIVE. I got this wrong FOUR times. ***
### Measured 2026-09-16 by controlled experiment with the repo's exact esbuild options.

Probe with one marker per position, bundled with `bundle/platform:node/format:esm/target:node22/sourcemap:false/packages:external`:

| position | survives into dist/*.js? |
|---|---|
| **object-literal property** | **YES** |
| **array-literal element** | **YES** |
| **class-body member** | **YES** |
| module scope, before a const | no |
| module scope, before a function | no |
| function-body statement | no |
| method-body statement | no |

**So: a comment leading a MEMBER of a braced/bracketed member list SHIPS. A comment leading a
STATEMENT is dropped.** `dist/mcp-server.js` carries **1,387** `//` lines and `dist/index.js`
**1,416** — comments are emphatically not stripped wholesale. Measured cost: ~75 bytes/line per
bundle, so ~150 bytes/line for `src/utils/*` and `src/services/*` (they ship in BOTH bundles) and
~75 for `src/mcp/*` (one bundle). T104 paid **460 bytes** for a 6-line comment above an
`idempotentHint:` property — knowingly, and it was right to: it guards the most contestable line
in that diff at the exact place someone would revert it.

For the `.d.ts` (unchanged, still correct): `tsc --emitDeclarationOnly` copies `/** … */` JSDoc
VERBATIM when it leads a declaration that REACHES the `.d.ts` — by export, or by being referenced
from an exported signature (a JSDoc on the non-exported `RepoEntry` cost +398 because
`__registerForTest(entry: Omit<RepoEntry,"name">)` is public on an exported class). `//` and plain
`/* … */` are NEVER copied into a `.d.ts`.

**PRACTICAL RULE:** put rationale in a function body, at module scope, or in the changeset — all
free. Putting it beside an object-literal property, an array element or a class field costs
~75-150 bytes per line. JSDoc on anything reachable from an exported signature costs its full
length in the `.d.ts`.

**HOW I GOT IT WRONG FOUR TIMES, so the next coordinator does not repeat it:**
v1 "braced member lists ship ~2x, statement-level stripped" — CORRECT, discarded in error.
v2 "comments are free wherever they sit" — WRONG. I ran two probes, `grep`ped for a
`worktree-sync.service.ts` comment and a `git.service.ts` comment in `dist/index.js`, got 0 and 0,
and generalised. **Both probes happened to be function-body comments** — a biased sample of the one
position that does drop. I then wrote this wrong rule into `scripts/smoke-test.mjs` and into
several worker briefs.
v3 added the `.d.ts` half (right) while keeping the wrong esbuild half.
v4 refined "exported" to include types reachable from exported signatures (right) — still wrong half.
**The lesson is about method, not esbuild: a probe that samples one syntactic position cannot
establish a rule quantified over all positions.** T37's reviewer wasted a pass hunting for prose
savings that did not exist because of v2. The T104 worker caught it by reading the bundle rather
than trusting the rule it was handed — which is exactly what a worker should do with a
coordinator's claim.
**`scripts/smoke-test.mjs`'s note still carries v2 and needs correcting in a later commit.**

## From T98 (detached-HEAD update_worktree) — 2026-09-16

- **FU-MCP-14 (correct the framing, not just the item).** `get_worktree_status` still
  resolves membership from two sources that disagree about detached entries, so it answers
  `not a registered worktree` on a cold session and a real status on a warm one, for a path
  that IS registered. Two agents left it, arguing "the harm cannot occur because the tool
  discards `.branch`". **That justification is wrong** and must not be recorded as closed:
  the pseudo-branch hazard is contained, but the misleading MESSAGE does occur, and it is the
  identical wrong answer T98 exists to remove, one call away in a sibling tool. What actually
  justifies deferring it is narrower — widening changes which paths a read-only tool accepts.
  Note `ensureRepoWorktreePath` has exactly ONE caller and returns `.path` alone, so the fix
  is a one-argument change with no blast radius; the "behaviour change outside this task"
  defence is weaker than it sounds. OPEN, not resolved.
- **FU-MCP-15.** Branch-bearing prunable rows, and branch-bearing locked rows whose checkout
  is gone, reach `fetchBranch`/`updateWorktree` and surface a raw `spawn git ENOENT` Node
  stack trace as `INTERNAL_ERROR`. Verified byte-identical on the parent, so pre-existing.
- **FU-MCP-16.** A branch whose ref is force-deleted under a live worktree (`git update-ref -d`)
  lists as `HEAD 000…0` + `branch refs/heads/X` and still reaches the fast-forward.
- **FU-MCP-17.** Mid-rebase and mid-bisect worktrees reduce to the plain `detached` shape, so
  they get `DETACHED_HEAD`. Not false, and nothing is fetched or merged, but the remedy named
  is the wrong one — `git rebase --abort` / `git bisect reset` would be right.
- **FU-GIT-1.** Nobody has tested whether git 2.55 (what CI runs) emits porcelain attributes
  beyond `bare`/`HEAD`/`branch`/`detached`/`locked`/`prunable`. The container has 2.43 only.
  T80 proved a real 2.55 can be built here when a version claim matters.

### THE PRODUCTIVE ATTACK — "ask for one extra row type, see what else comes with it"

T98 found **three** row shapes that a filter had been suppressing only as a SIDE EFFECT of
filtering something else, and each one made the tool answer the wrong thing:
 (a) the bare repo's own row → would have called `fetchBranch("")`, an empty refspec;
 (b) a prunable detached registration → `DETACHED_HEAD` naming a remedy for a directory that
     is not there;
 (c) **a LOCKED detached registration whose checkout is gone** — git does NOT compute
     `prunable` for a locked registration, so it is indistinguishable in the listing from a
     live detached checkout, and NO filter over the listing could have known. Needed a
     filesystem probe, narrowed to exactly that shape. It is also the LIKELIEST of the three:
     a worktree on media that is not always mounted is git's documented reason to lock one.
Found by three different agents in succession — the worker, a reviewer that then died in a
container restart, and its replacement. **Generalise: when a change relaxes a filter, enumerate
every input shape the old filter was incidentally excluding, not just the one you wanted.**

### A FOURTH TEST-HARNESS TRAP — a precondition guard satisfied by its own fixture name

The real-git suite guarded against CI's newer git changing output shape with
`expect(porcelain()).toContain("detached")`. The fixture directory is created with the mkdtemp
prefix `sync-worktrees-mcp-detached-`, which appears in EVERY `worktree <path>` line — so the
guard would have passed unchanged had git stopped printing the flag entirely. Measured: 2
matching lines in a repo with no detached worktree at all. **Anchor precondition guards to a
whole line (`/^detached$/m`), and pair a presence assertion with the absence of its
counterpart.** Related, same commit: a test can pin the CALL ARGUMENT rather than the OUTCOME
and survive the behaviour changing — check which one a "pinning" test actually holds.

## From T99 (broken config invisible to the agent) — 2026-09-16

- **FU-MCP-18.** The discovery cache returns a stale broken result (note AND `configPath: null`)
  for up to its 5 s TTL after a repair, on a worktree path. Pre-existing and self-healing
  (measured stale to t=+4049 ms, `managed` at t=+5269 ms); T99 only adds a note to an
  already-stale result.
- **FU-MCP-19.** Once a config has loaded successfully, `detectFromPath` never re-reads it
  (`configPath !== null` skips the whole auto-load block), so a config broken *after* a good
  load stays in force silently with no note. `configPath` is assigned in exactly one place and
  never reset to null.
- **FU-CFG-2.** `configErrorLocation` appends the *config* path even when the `SyntaxError`
  came from a module the config imports, so the message points a reader at a file that parses
  fine. Pre-existing; T99 makes it model-visible for the first time.
- **FU-MCP-20.** `capabilities.sync.reason` still reads "no config file loaded (running in
  auto-detect mode)" in the broken case; only `notes` tells the fuller story.
- **FU-MCP-21.** The `[sync-worktrees]` stderr prefix here differs from `[sync-worktrees-mcp]`
  used throughout `src/mcp/index.ts`.

### A NEW TEST-HARNESS TRAP — `fs.utimes` cannot round-trip a stat'd mtime

`fs.utimes(f, stat.atime, stat.mtime)` does **NOT** restore the timestamp: `stat.mtime` is a
`Date` (whole milliseconds) while ext4 records `mtimeMs` with sub-millisecond precision, so
writing it back TRUNCATES and the mtime changes. Measured: recorded `1789559098234.5708`,
after `utimes(stat.mtime)` → `1789559098238`.
**Consequence:** a test trying to hold mtime constant so a content hash is the only signal
silently fails to hold it, and the hash is never exercised. That is exactly how T99's central
safety property went unpinned — dropping the sha256 comparison and leaving a mtime-only gate
**survived all 286 `src/mcp` tests**. Pin to a WHOLE SECOND (exactly representable, exactly
restorable) and assert the premise — `mtimeMs` equal AND size equal — before drawing any
conclusion from the test.

### THE FIXTURE-PREMISE GUARD, and why it is worth a test of its own

T99's suite opens with a test asserting its fixture is one *real Node* refuses to parse.
Mutating the fixture to be syntactically VALID still left 7 of 9 tests passing — because the
fixture then fails *validation* instead of *parsing*, and those tests only care that the note
plumbing works. One test stands between the whole suite and a premise holding for the wrong
reason. Worth copying wherever a suite depends on a fixture being broken in a specific way.

### A CLAIM CAN BE FALSE WHILE THE PROPERTY IT PROTECTS HOLDS

T99's comment, changeset and commit message all said the fingerprint is computed "only when a
failure is already on record". Measured with `strace`: it is computed UNCONDITIONALLY before
the gate is consulted — the healthy path goes from 1 file open to 2. The *property* I asked
about ("must not gain a file read per detect") still holds, because detects 2-5 skip the path
entirely once `configPath` is set, so it is one extra read for the life of the process. The
code was left alone (taking the fingerprint before the attempt is load-bearing: recording
post-failure bytes would pin an edit that landed mid-import as already tried); the prose was
corrected to say what the code does. **Check a stated claim by measurement even when the
behaviour it is defending is correct.**

## From T100+T101 review (2026-09-16)

- **FU-T101-1 — `upstreamGone` false-positives on a branch tracking a local branch.** `branch.x.remote = "."` resolves `@{upstream}` to a bare local name that `git branch -r` never lists, so `upstreamGone` is true, the label is `stale` and `detect_context`'s `staleHint` is true for a perfectly healthy worktree. Measured on git 2.43.
- **FU-T101-2 — `upstreamGone` is unreachable for the case it exists for.** A pruned upstream makes `rev-parse --abbrev-ref <b>@{upstream}` exit 128, so `snap.upstream` is null and the flag never sets. `fullyPushedUpstreamDeleted` covers the squash-merge case from metadata, but the `upstream gone` reason and the `stale` label are dead for their intended trigger. (So FU-T101-1 is the *only* way it fires, on healthy repos.)
- **FU-T101-3 — MCP output schemas are almost entirely unvalidated by tests.** Only `create_worktree` and `sync` were ever `.parse()`d; T101's review added spot-parses for `list_worktrees` and `get_worktree_status`. `detectContextOutputSchema` and the rest have nothing, so a required field added to any of them can break `tools/call` on the wire with a fully green suite. Demonstrated: dropping `divergence` from `handleGetWorktreeStatus` passed all 289 MCP tests while breaking the advertised schema.
- **FU-T101-4 — `list_worktrees` carries `divergence` twice per entry** (top level and under `status`). Schema-valid, consistent and backwards compatible, but duplicated wire bytes per worktree and the top-level copy is now derived — a deprecation candidate.
- **FU-T101-5 — corrupt remote-tracking ref makes divergence report `{0,0}` where it used to report `null`.** Where the ref exists but its object does not (pointing at a missing oid, or at a non-commit), `git status` prints `[gone]` with 0/0 while the old rev-list failed. Deliberately not fixed in T101: separating the cases costs back the per-worktree process it removed, and the only zero-cost discriminator available would null out FU-T101-1's legitimate local-branch upstream. Documented in `worktree-status.service.ts`.
- **FU-T101-6 — the discovery-cache bound test asserts a loose ceiling** (`toBeLessThan(80)`), so it cannot tell 64 from 79; only a limit above the probe count trips it.
- **FU-T101-7 — `detectFromPath` has no in-flight dedup**, so concurrent probes of the same path both miss and both detect.

## From T102 (worker + review, 2026-09-16)

- **FU-T102-1 — a linked worktree of an ORDINARY (non-bare) clone is reported as a sync-worktrees repository.** The gitdir regex matches `<repo>/.git/worktrees/<name>` as readily as `<bare>/worktrees/<name>`, so `detectFromPath` returns `kind:'unmanaged'` with `bareRepoPath: <repo>/.git` and derives a `worktreeDir` from wherever those worktrees sit. `siblingRepositories` and the auto-detected entry then get built around a `.git` directory that is not a bare repo. Pre-existing; unchanged by T102.
- **FU-T102-2 — `buildUnsupportedContext` and `detectFromPathUncached`'s inline `unsupported()` disagree.** The exported one (used at `src/mcp/server.ts:113` when detection throws) always reports `configPath: null`, `notes: [reason]` and drops `configuredRepositories`; the inline one reports `this.configPath` and the accumulated notes including T99's "found config but it failed to load". A throwing detect therefore erases the config path the previous call reported.
- **FU-T102-3 — `unsupported` AND clone-mode results are never cached.** `rememberDiscovery` is gated on `result.isWorktree && result.bareRepoPath && adminDir`; clone-mode has `bareRepoPath: null`, so it misses too. Every `detect_context` from an unmanaged or clone-mode path re-walks from scratch. Measured: `__discoveryCacheSizeForTest()` stays 0 across repeated calls. (Cost for the no-`.git` case is unchanged by T102 — 18 openat at depth 15, before and after.)
- **FU-T102-4 — every `unsupported` reason is serialised seven times**, six `capabilities.*.reason` plus `notes`. Structural in `emptyCapabilities`. T102 capped the reason's length; it did not address the multiplier.
- **FU-T102-5 — `isCacheFresh` does not cover what the answer now depends on.** It checks the TTL plus `<adminDir>/HEAD` and `<bare>/worktrees` mtimes. Creating or deleting a nested `.git` between the probed path and the worktree changes the answer and touches neither, so a stale answer can be served for up to `DISCOVERY_CACHE_TTL_MS`.
- **FU-T102-6 — `findConfiguredCloneEntry` is now O(depth x repos)** instead of O(repos): in-memory `path.resolve` + case-fold per entry per level. Negligible, but a new loop inside a loop.
- **FU-T102-7 — `readConfiguredCloneWorktree` compares paths with a raw `normalizePathForCompare(a) === normalizePathForCompare(b)`** where the rest of the file uses `pathsEqual`. Same semantics, inconsistent call.
- **FU-T102-8 — `REVIEW_FINDINGS.md` is tracked at the repo root** and is not in `package.json` `files`, so it does not ship, but it is still in the repository. Resolved: moved to `docs/internal/` with the other engineering records.
- **ENVIRONMENT — simple-git's unsafe-operations plugin blocks `-c protocol.file.allow=…` and any inherited `GIT_EDITOR`**, so a `file://` submodule fixture cannot go through `createGitClient`/`simpleGit`; use `child_process` directly.

## From T105 (worker + review, 2026-09-16)

- **FU-T105-1 — three `??` fallbacks are unreachable, downstream of `getReadyService`.** `listWorktreesForRepo`'s `repoName ?? ctx.getCurrentRepo() ?? "current repository"`, `notStartedError`'s `ctx.getEntry(repoName)?.name ?? repoName ?? "unknown"`, and `handleSync`'s `ctx.getEntry(params.repoName)?.name ?? params.repoName`. By the time each runs, `getService` has already resolved the name and thrown on a miss, so the final arm is dead. Defensive, not a gap — recorded so nobody "fixes" a test onto them.
- **FU-T105-2 — `makeCtx` has two more trap-2 `??` defaults.** `getCurrentRepo: … ?? "test"` can never return null and `getEntry` returns a constant non-null entry, so those production fallbacks are unreachable from all 124 tests in that file. Proven by changing the literal and still passing 124/124.
- **FU-T105-3 — `detectFromPath` walks to `/` from `os.tmpdir()` in tests with no config.** A stray `sync-worktrees.config.{js,mjs,cjs,ts}` in `/tmp` or `/` would load and flip `capabilities.sync.available`, failing flows that assume auto-detect mode. None present today; pattern predates T105 and is shared with `handlers.capability-gate.test.ts`.
- **FU-T105-4 — `makeCtx`'s service double drops `getWorktrees`' options** (`mockImplementation(() => git.getWorktrees())`), so `{ includeDetached: true }` never reaches the git double from `handlers.test.ts`. Pre-existing.
- **FU-T105-5 — `WorktreeSyncService.getWorktrees`' clone-mode branch is exercised only through doubles.** No MCP test drives a real clone-mode service end to end.
- **FU-T105-6 — the `structuredContent` === JSON-text-block assertion cannot catch an `undefined`-valued key**, which is the one divergence `JSON.stringify` actually introduces, because vitest's `toEqual` ignores undefined properties. The comment above it oversells what it proves.
- **FU-T105-7 — `ensureRepoWorktree`'s "vanished locked detached worktree" branch** (`probePathExists(...) === "missing"`) is reached by none of the six new flows.
- **METHOD — a test deliverable's failure mode is a suite that binds nothing.** T105's own new file added a third double (`isInitialized → true`) that hid a production path, in the task whose purpose was to stop doubles hiding production paths. Require a mutant per sequence, chosen by someone other than the author, and run the mutant against the WHOLE suite, not just the new file.

## From T42+T43+T107+T117 (worker + review, 2026-09-16)

- **FU-T42-1 — the help modal advertises a shortcut that has never existed.** `HelpModal.tsx` lists "q / Esc — Gracefully quit", but `App.tsx` handles only `q`; `key.escape` is handled solely inside the help modal. README says the same. (Overlaps T109, still open.)
- **FU-T42-2 — `q` is dead while the help modal is open.** `App.tsx`'s `if (showHelp) { … return; }` accepts only `?`/`h`/Esc, so `?` then `q` does nothing — the one modal that is not a wizard still eats the quit key.
- **FU-T42-3 — `r` during the shutdown wait can resurrect the daemon.** The UI stays live for the whole wait and `handleReload` ends in `setupCronJobs()`, re-registering tasks `cancelCronJobs()` just released. Only `process.exit` winning the race prevents it. Pre-existing on both sides of the change — `isDestroyed` never guarded `handleReload` or `runSyncCycle`.
- **FU-T42-4 — a rejected first teardown is cached forever.** `this.shutdown` keeps the rejection, so no later `q` or signal can retry; recovery rests on the 3 s signal watchdog and the mouse `exit` backstop.
- **FU-T42-5 — a clean SIGINT to the interactive CLI exits 0, not 130.** `src/index.ts` calls `setupSignalHandlers()` with no options so `exitAfterCleanupCode` defaults to 0; the run-once branch passes 130 explicitly.
- **FU-T42-6 — `DEFAULT_FORCE_EXIT_MS` (3 s) is shorter than the `q` wait (30 s)** and the two are set independently. A SIGTERM inside `FORCE_QUIT_GUARD_MS` of a `q` press drops its own 2 s fast timeout and rides the 30 s wait, exiting at 3 s/130 instead of ~2 s/0. Bounded, still an escape.
- **FU-T42-7 — `handleReload`'s `waitForInProgressSyncs()` has no abort.** Pressing `r` can block the UI for up to 30 s with no way to cancel.
- **FU-T42-8 — `InteractiveUIService.registerCronJob` has no production caller**, and `renderUI()`'s `if (this.app) this.app.unmount()` is unreachable (the method is only called from the constructor).
- **FU-T42-9 — `src/__tests__/setup.ts` makes real Ink unrenderable.** It replaces `global.console` with a plain object spread that has no `Console` constructor, so any `render()` with Ink's default `patchConsole: true` throws. Every TUI test using real Ink must restore it locally; the fix belongs in setup.

### Two new test-harness traps (both cost a real defect this round)

- **TRAP 12 — a `vi.fn` returning a rejected promise can NEVER produce an unhandled rejection.** Vitest attaches its own handler to the returned promise to record `settledResults`. A test asserting "we do not crash on a late rejection" against a `vi.fn` double proves only that a log line appeared. Use a plain function that rejects from a timer. Verified both ways.
- **TRAP 13 — an incomplete test double can be the ONLY thing covering a catch arm.** A cron double with `{ stop: vi.fn() }` and no `destroy` made `cancelCronJobs()` throw a `TypeError` that the production `catch` swallowed — which is what "covered" that arm. Completing the double moved coverage DOWN. Look for catch arms whose only exercise is a double's own incompleteness.

## From T110+T114 (worker + 5-lens review + fixer, 2026-09-16)

- **FU-T110-1 — `fetchTimeoutMs`/`cloneTimeoutMs` carry the same 2^31 overflow (pre-existing).** `validateTimeoutMs` (`config-loader.service.ts:812-816`) gates on `Number.isSafeInteger`, and `Number.isSafeInteger(31536000000)` is `true`, so a year-long fetch timeout loads cleanly and reaches simple-git's own `setTimeout`, clamps to 1 ms and kills the fetch immediately. Same one-clause fix as T114's; deliberately not applied.
- **FU-T110-2 — the timeout path's 5 s SIGKILL escalation is reachable but untested.** `executeCommandInBackground` arms it and nothing clears it while the hook runs, but no test waits 5 s to see it fire; the only coverage is that the timer gets cleared. A fake-timer test would pin it cheaply.
- **FU-T110-3 — the 250 ms termination grace is not interruptible by a force-quit.** `releaseForceQuit` is already null by the time `cleanup()` runs, so a second `q` inside the window does nothing. Bounded, so low priority.
- **FU-T110-4 — `handleReload` (`r`) never calls `hookExecutionService.cleanup()`.** Hooks from a previous config generation keep running across a reload and keep feeding the new UI's log panel through the old callbacks.
- **FU-T110-5 — `onStdout`/`onStderr` still do not name their command.** T114 fixed attribution only for `onComplete`, so concurrent hook output stays interleaved and unattributable.
- **FU-T110-6 — `branch-created-actions.service.ts` is bundled into `dist/mcp-server.js` but its hook path is unreachable there** (the service it calls is type-erased out), so `runHooks` and its log strings are dead weight in the MCP bundle.
- **FU-T110-7 — `"Terminating N hook(s) still running"` is emitted after the hooks are already gone**, since the list is logged after the awaited `cleanup()`. Present tense is a shade stale.
- **FU-T110-8 — `FileCopyService.copyFiles`' outer catch conflates "no patterns matched" with "the copy failed"** — overlaps T116.

### Byte-rule refinements (both measured and confirmed by me)

- **The `//`-ships rule covers any CLASS-BODY MEMBER, methods included — not just fields.** Verified: all five lines of the `//` block leading the *method* `buildEnvironment` appear in `dist/index.js`. The fixer moved ~20 lines of method-leading rationale into method bodies and saved ~1.5 kB; the delta would have been ~+2,900 instead of +1,446.
- **A `/** … */` on a PRIVATE method ships in the bundle but does NOT reach the `.d.ts`.** Verified: `dist/services/hook-execution.service.d.ts:21` is `private waitForExit;` with no comment, while `waitForExit` appears twice in `dist/index.js`. So a private-method JSDoc is bundle-only cost.

### Method lessons

- **MEASURE THE MECHANISM BEFORE COMMITTING TO A PRINCIPLE'S IMPLEMENTATION.** My principle (never silently destroy in-flight work) was right; the implementation I assumed would serve it (stop killing hooks) made the same death messier and silent.
- **A REPORT'S NARRATIVE CAN CLAIM CREDIT THE DIFF DOES NOT CONTAIN.** A claimed 311-byte comment removal was not in the commit at all — `git diff | grep -c '^-.*//'` was 0. Totals still reconciled, so it was narrative, not arithmetic. Check claimed removals against the diff, not the prose.
- **"STILL ALIVE" IS NOT `exitCode === null`.** With `sh -c` holding a grandchild, the direct child reads as dead while the work runs on. Watch the streams.

## From T111+T112 (worker + 5-lens review + fixer, 2026-09-17)

- **FU-T111-1 — ~9.2 KB of shipped comments in `src/constants.ts`.** Member-leading comments there ship ~4,596 bytes into `dist/index.js` AND the same again into `dist/mcp-server.js` (billed twice) under the braced-member-list rule. Moving them above their statements would reclaim roughly 9 KB of the ~111 KB headroom. Approximate (presence-checked with `grep -oF`, sizes source-side).
- **FU-T111-2 — `commandExists` shells out to `which`**, absent from minimal images (Debian slim, Alpine without debianutils). Every candidate would read "not found", producing "No terminal launcher found" on a machine that has a terminal. `command -v` via `sh` is portable.
- **FU-T111-3 — the editor-refusal path now probes.** Wording the message costs up to five `spawnSync("which", …)` calls, on that path only. New syscall work where there was none.
- **FU-T111-4 — AppleScript escaping in the darwin fallback escapes only `\` and `"`.** The interpolated tmux command is built from `shellEscape`'d parts so it is probably safe; unverified on macOS.
- **FU-T111-5 — `OpenEditorWizard` shows `result.error`, but the async exit-code log lands only in the TUI log pane**, so a user who quits immediately after the wizard closes never sees it. Inherent to a detached launcher; a future item could hold the wizard open briefly in Editor mode.
- **FU-T111-6 — `EDITOR="   " VISUAL=code` now reports an error instead of falling through to `VISUAL`.** Deliberate: a set-but-blank `EDITOR` is a misconfiguration worth surfacing, and it already shadows `VISUAL` today when it names a nonexistent binary. Recorded because it is a judgement call, not an oversight.

### Environment and byte-rule refinements (all measured)

- **THE BARE `tsc` ON PATH IS TypeScript 6.0.2; THE REPO'S IS 7.0.2.** A mutation gate run with bare `tsc` uses the wrong compiler. Always `pnpm exec tsc` or `./node_modules/.bin/tsc`. (Verified: `tsc --version` → 6.0.2, `pnpm exec tsc --version` → 7.0.2. My own earlier gates used `pnpm exec`, so they were sound.)
- **Counting `/*` in the bundle is NOT a valid proxy for shipped comments.** esbuild adds `/* @__PURE__ */` annotations, so removing two JSDoc blocks left the count unchanged (496 both ways: pure annotations 429 → 431, `/**` 32 → 31). Only `grep -oF <marker>` is reliable — trap 1, one level up.
- **A `/** */` on an object-literal member of an exported const reaches BOTH the bundle AND the `.d.ts`.** Measured: the two `TERMINAL_CONSTANTS` blocks cost 278 bytes in `dist/index.js` and 288 in `dist/constants.d.ts` — tsc copies a member JSDoc into the declaration. Total reclaim 566, not 278. A `//` above the statement is copied nowhere.

### Method lessons

- **HANDING SOMEONE A RULE DOES NOT MEAN THEY APPLY ALL OF IT.** The worker had the braced-member-list byte rule, applied it correctly to its function-body comments, and asserted "zero comments shipped" while two JSDoc blocks on object-literal members shipped 278 bytes. **Verify a claim of absence by rebuilding, not by reading the source.** Same failure mode as cluster 2's phantom 311-byte credit, from the opposite direction.
- **A ROUTE CAN FAIL ON ITS OWN TERMS IN THE ENVIRONMENT THAT NEEDS IT.** Routing terminal editors through the terminal launcher looked strictly better until someone checked whether a terminal emulator exists on the host at all — it does not here, so the remedy would have answered an editor request with a terminal error.
- **FIXING ONE ASYMMETRY CAN CREATE ITS MIRROR IMAGE.** The `$TERMINAL` branch was made to consult the flag helper, but appended unconditionally, so `TERMINAL="alacritty -e"` produced `alacritty -e -e sh -c` — the override bug reflected. Found by the fixer, not the review.
- **FU-T25-1** (latent, tui) — `getDivergedDirectoriesForRepo` still has T25's exact shape: `Promise.allSettled(...)` filtered to fulfilled only, so a `.diverged` entry whose mapper rejects vanishes from a list that looks complete. Today every `await` inside the mapper is caught, so the filter is dead code — but it is the same bug T25 fixed, in the function immediately below it, with no test to catch its reinstatement the moment an uncaught `await` is added.
- **FU-T25-2** (leak, tui) — `DiskUsageCache.measured` never evicts. A long-running daemon accumulates one entry per directory ever measured, including every `.diverged/` directory since deleted. ~40 bytes each, so a slow leak rather than a hazard, but nothing bounds it and nothing prunes on TTL expiry.
- **FU-T25-3** (correctness, tui) — the header's disk total silently under-reports. `calculateSyncDiskSpace` absorbs each rejection with `.catch(() => 0)`, so one unreadable directory subtracts its whole size from the total with no indication, and a total failure renders `"0 B"` (not `"Calculating..."`, because `"0 B"` is truthy in `StatusBar`'s `diskSpaceUsed || ...`). `getRepositoryDiskUsage` already prefixes a partial failure with `≥`; the consistent fix is to do the same here. Pre-existing; T25 corrected only the docstring.
- **FU-T25-4** (performance, tui) — `.diverged` metadata reads are unbounded. The `du` walks are now bounded by the cache's limiter, but the `fs.readFile` of each `.diverged-info.json` still fans out over every subdirectory at once. Small files, so an fd-count question rather than a throughput one.
- **FU-T44-1** (correctness, clone mode) — clone mode still swallows its own leftover-branch notice. The worktree path was fixed by having the rollback feed a `leftovers` collector the retry loop reads, but `clone-sync.service.ts:rollbackCreatedBranch` throws through `service.createAndPushBranch` and never touches that collector, so when the lease refuses AND the compare-and-swap delete also fails, the notice naming the orphaned branch is still discarded by the same retry. Fixing it properly wants a typed error or a shared notice helper across both services.
- **FU-T44-2** (ergonomics, tui) — `resolveFreeBranchName` appends to the typed name, so a user who explicitly types `x-1` while `x-1` is taken is shown `x-1-1` (and the service then continues `x-1-2`, consistently with what was displayed). The service-side walk now continues a suffix rather than nesting it; the wizard's own derivation does not. Only matters when the user types a `-N` name by hand.
- **FU-T44-3** (security, tui) — the credential redaction restored in `rollbackUnpushedBranch` covers the push-failure path. Worth a sweep for other `getErrorMessage(...)` results that reach the TUI from a network git command without passing through `redactSecretsInText`, since the two services drifted here once already and nothing enforces the pairing.
- **FU-T113-1** (testing, lock) — the real lock logic is still only covered on the happy path. Stale-lock takeover (`LOCK_STALE_MS`, 600 s), the mtime refresh timer (`LOCK_UPDATE_MS`, 30 s), the `onCompromised` warn-and-continue callback, and the `waitMs`/`retriesUntil` retry budget are exercised nowhere outside mocks — `repo-operation-lock.test.ts` mocks both `fs/promises` and `proper-lockfile`. A ~2 s two-process run cannot reach any of them; they need a test that fabricates an aged lock or drives the timers.
- **FU-T113-2** (design, lock) — in worktree mode the bare-repo lock masks a `worktreeDir` lock-key regression. `acquireWorktreeModeLock` takes the bare lock first and returns early, so two processes are serialized by it regardless of what the worktreeDir key derives to: putting the pid in the lock filename still produced correct contention outcomes, and was caught only by an explicit assertion on the derived path. Nothing asserts the two-lock ordering, or the bare-lock release when the second lock cannot be taken. Clone mode's single-lock path is not exercised at all.
- **FU-T113-3** (testing hygiene) — other e2e suites leave `os.tmpdir()` fixtures behind: `/tmp` accumulates stale `sync-worktrees-*`, `mcp-wtdir-*` and `test-config-*` directories across sessions. Worth finding which suites are responsible.
- **FU-T113-4** (consistency) — the e2e layer spawns two different entry points: `lock-unavailable` and `node-env-independence` use `bin/sync-worktrees.js`, while `double-run` and `concurrent-runs` use `dist/index.js` directly. `bin/sync-worktrees.js` additionally does `process.env.NODE_ENV ??= "production"`, so the two paths are not the same child environment. Not a defect now that nothing branches on NODE_ENV, but someone should settle it deliberately.
- **FU-T108-1** (security, tui) — `handleReload` builds `repo: repoConfig.name || repoConfig.repoUrl` for its clone-skip lines, so a repository with no configured `name` puts a **raw** `repoUrl` — credentials included — into the log panel, where `redactRepoUrl` is used everywhere else. Pre-existing, two lines from the code cluster 9 changed. Pairs with FU-T44-3: nothing enforces that a URL reaching the TUI has been through `redactSecretsInText`/`redactRepoUrl`, and the codebase has now drifted here twice.
- **FU-T108-2** (testing) — `interactive-ui.service.test.ts`'s `should re-inject loggers after reload` is now a weak duplicate: it asserts injection happened, which is true, but it is order-blind (verified — it passes under a mutation that moves the assignment after `initialize()`). The new order assertion in `interactive-ui.reload-logging.test.ts` supersedes it. Delete it or fold it in, so nobody reads it as covering the ordering.
- **FU-T108-3** (tui) — a repository whose `initialize()` fails during a reload can leave a progress row keyed to its name. It is cleared when the reload's cycle closes (`setStatus("idle")` empties the list), so it is bounded to the reload, but nothing pins that clearing path specifically.
- **FU-T109-1** (testing, tui) — `HelpModal.test.tsx`'s blind spot is only narrowed, not closed. T109 added the one assertion it needed (that the quit row names `q` alone), but the modal still advertises `s c o w x r ? h gg G j k` and the mouse wheel with **no test tying any of them to App's handler** — it asserts the help text renders, never that the listed keys work. That is exactly how `Esc` drifted. A table-driven App-level test over every advertised key would close it for good.
- **FU-T109-2** (dead code, tui) — `App.tsx`'s `key.escape` inside the `showHelp` branch is redundant: `HelpModal`'s own `useInput` already calls the same `onClose`, and a mutation removing only the App-side path survives the whole suite. The user-visible behaviour is pinned (removing BOTH paths is killed by two named tests), so this is untested-by-necessity code rather than an untested behaviour. Worth deleting for clarity.

## From ci-hygiene (macOS CI leg, 2026-09-25)

- **FU-CI-1** (correctness, darwin) — the macOS leg added to `.github/workflows/pr.yml` fails 15 tests in 11 files, so its test step runs with `continue-on-error` (lint, type check, build and smoke still gate it). First run: PR #133, job 108137002497 — `Test Files 11 failed | 159 passed`, `Tests 15 failed | 3231 passed`.
  - **Root cause for most of them:** `GitService.isRegisteredWorktree` (`src/services/git.service.ts`) compares `path.resolve(worktreePath)` with `path.resolve(w.path)` from `git worktree list --porcelain`. On macOS `os.tmpdir()` is `/var/folders/...`, a symlink to `/private/var/folders/...`, and git reports the canonical path, so the two never match and `ensureMainWorktree` throws `WORKTREE_NOT_REGISTERED` (`main worktree at '/var/folders/.../worktrees/main' is not registered with the bare repository`). The same would hit any user whose `worktreeDir` goes through a symlink. The fix is to canonicalise both sides with `fs.realpath` (falling back to `path.resolve` for paths that no longer exist) in every worktree-path comparison, not only this one.
  - Files failing on that error: `bare-origin-mismatch`, `concurrent-runs`, `diverged-branch-reservation`, `double-run` (3 tests), `head-branch-filter` (2), `node-env-independence.e2e` (2), `skip-lfs-global-ignore.e2e`, `stale-registration`, `worktree-dir-collision.e2e` (all under `src/__tests__/e2e/`).
  - `src/mcp/__tests__/context.broken-config.test.ts` ("carries the note on an unmanaged worktree context…", `expected 'unmanaged' to be 'managed'`) is very likely the same mismatch, in `detectFromPath`'s path matching.
  - `src/__tests__/e2e/unshallow-inactivity-timeout.e2e.test.ts:151` ("still kills an unshallow that goes quiet…", the clone is no longer shallow after the kill) is a separate failure and has not been diagnosed. The test's `sleep` shim and how the process is killed may behave differently on darwin.
  - When all of these pass on macOS, remove `continue-on-error` from the "Run Tests with Coverage" step in `pr.yml`.
