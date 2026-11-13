# Audit plan — sync-worktrees 7.2.2

Full-repository audit at commit `3383f25` (2026-11-12). 82 tasks (8 P0, 24 P1, 31 P2, 19 P3), each written so one agent can pick it up cold.

## How this was produced

- Baseline on Node 24: `pnpm lint`, `format:check`, `typecheck`, `build`, `smoke`, unit (3,773 tests) and e2e (152 passed, 5 skipped) are **all green**. Nothing below is "CI is red"; everything comes from reading the code and running it.
- Every source file under `src/`, plus `bin/`, `scripts/`, workflows, docs, `site/` and `demo/`, was read in full by one of eight area reviewers. Each finding was then re-checked. The tag on each task says how far that check went:
  - **[reproduced]** — re-run end to end for this plan against the built CLI/server in a throwaway sandbox.
  - **[code-checked]** — the reviewer reproduced or traced it, and the cited code was re-read for this plan and matches.
  - **[reviewer-reproduced]** — the reviewer ran a reproduction; not independently re-run.
  - **[reviewer-traced]** — established by reading only.
- Leads that could not be confirmed are in [Not in the plan](#not-in-the-plan), so nobody mistakes them for work items.

## Rules for the agent doing a task

1. **Test first.** Write the failing test described under "Done when" and confirm it fails on `main` before changing code. If it does not fail, the finding is wrong or already fixed: stop and report, do not "fix" anything.
2. One task per branch/PR. Stay inside the files the task names; if the fix needs another lane's file, say so in the PR.
3. Every PR that touches `*.ts/tsx/js/mjs/cjs/json` outside `site/` needs a changeset (`pnpm changeset`; `patch` for fixes, an empty changeset for test- or tooling-only changes). CI rejects the PR otherwise.
4. Before pushing: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test:unit && pnpm test:e2e && pnpm smoke` on Node >= 24.
5. `pnpm smoke` enforces a 1,000,000-byte tarball ceiling and the build is 973,422 bytes today. The bundle is not minified, so **comments ship**. Do task **TOOL-1 first**, and keep new comments short.
6. Do not skip, weaken or delete a test to get green. A test that pinned the buggy behaviour is updated to pin the fixed behaviour, and the PR says so.

## Lanes and ordering

Tasks in one lane touch the same files: run them **in the listed order, one at a time**. Different lanes can run in parallel.

| Lane | Main files | Tasks |
| ---- | ---------- | ----- |
| 0 — first | `scripts/smoke-test.mjs` | TOOL-1 |
| ENGINE | `worktree-mode-sync-runner.ts`, `worktree-sync.service.ts`, `git.service.ts`, `worktree-*.service.ts`, `sparse-checkout.service.ts`, `utils/retry.ts` | ENG-1 … ENG-18 |
| CLONE | `clone-sync.service.ts`, `clone-sync/*`, `git-maintenance.service.ts` | CLN-1 … CLN-11 |
| CONFIG | `config-schema.ts`, `config-loader.service.ts`, `utils/cli.ts`, `cli/*.ts`, `utils/interactive.ts`, `types/` | CFG-1 … CFG-13 |
| TUI | `src/components/*`, `InteractiveUIService.tsx` | TUI-1 … TUI-10 |
| MCP | `src/mcp/*`, `utils/mcp-registration.ts` | MCP-1 … MCP-13 |
| TRASH | `trash*.service.ts`, `cli/trash-command.ts`, `hook-execution.service.ts`, `file-copy.service.ts`, `utils/disk-space.ts` | TR-1 … TR-8 |
| TOOLING | workflows, configs, `scripts/`, `site/`, docs, test infrastructure | TOOL-2 … TOOL-8 |
| LAST | everything | DEAD-1 |

Cross-lane dependencies:

- **ENG-1 before MCP-9 and TOOL-2** (they reuse its path helper; TOOL-2 removes the CI mask once ENG-1 and MCP-9 are in).
- **ENG-2 touches one clone-mode file** (`clone-sync/remote-config.ts`); run it before the CLONE lane starts.
- **ENG-3 touches `trash.service.ts`**; run it before TR-3/TR-4.
- **ENG-10 before MCP-13** (same double-fetch, handler side).
- **CLN-4 edits `InteractiveUIService.tsx`** (the header disk total); do not run it at the same time as TUI-5, which edits the same file.
- **CFG-5 before TUI-5** (TUI-5 reads the precedence CFG-5 settles).
- **DEAD-1 runs last**, after every other lane has merged, so it does not conflict with them.

Priorities: **P0** data safety or breaks a common setup · **P1** broken behaviour · **P2** inconsistent behaviour/docs · **P3** inefficiency, dead code, hygiene.

## Decisions baked into the specs

Each of these has a default so no agent is blocked. Change the spec before dispatch if you disagree.

| Task | Decision | Default taken |
| ---- | -------- | ------------- |
| TOOL-1 | Raise the tarball ceiling or trim the bundle | Raise to 1,150,000 bytes; DEAD-1 claws some back |
| CFG-5 | `parallelism.maxRepositories`: top-level wins, or `defaults` wins | `defaults` overrides top-level, matching the docs and every other parallelism field |
| CLN-5 | Default branch with `branch` unset: follow docs ("resolved at clone time") or keep re-resolving | Follow the docs: an existing clone keeps the branch it tracks |
| CLN-8 | `skipUpdateWhenOutsideSparse` in clone mode: implement or document as worktree-only | Implement (the helper already exists) |
| ENG-16 | `parallelism.maxBranchFetches` controls only unreachable code | Keep accepting the key, warn it is deprecated, drop it from docs |
| TR-7 | Hooks in one `onBranchCreated` array run concurrently | Run them sequentially in array order |

---

## Lane 0

### TOOL-1 · P1 · Tarball is 26.6 kB under the smoke ceiling; the comments guarding it are stale [code-checked]

- **Problem:** `pnpm smoke` reports `14 files, 973422 bytes unpacked` against `MAX_TARBALL_UNPACKED_BYTES = 1_000_000`. The comment says "~0.85 MB … 845,789 bytes … moves by single-digit kB at a time"; the bundle grew 127 kB in the last 27 commits. Almost any task below adds bytes, so parallel fix PRs will start failing `pnpm smoke` (PR CI and `prepublishOnly`) for a reason unrelated to their change.
- **Where:** `scripts/smoke-test.mjs:60-64, 90-95, 346`; `.github/workflows/release.yml:38`.
- **Fix:** set the ceiling to 1,150,000; rewrite the size/history comment with today's measured numbers (esbuild output 907,495 bytes); correct line 346 ("installs npm@latest" — the release job pins `npm@11`).
- **Done when:** `pnpm build && pnpm smoke` passes with the new number printed; `grep -n "npm@latest\|0.85 MB\|845,789" scripts/smoke-test.mjs` is empty.

---

## Lane ENGINE — worktree-mode sync and the git layer

### ENG-1 · P0 · A `worktreeDir` that passes through a symlink fails to initialise and can quarantine a live worktree [reproduced]

- **Problem:** git prints canonical (realpath) worktree paths; the code compares them to `path.resolve()` of the configured path. With `worktreeDir: <symlink>/wt` the first `--run-once` creates `main` and then fails: `main worktree at '…/link/wt/main' is not registered with the bare repository … after creation`. At service level, `addWorktree` via the symlink spelling does not recognise the live worktree, logs "Cleaning up orphaned directory", moves it to `.removed/` and recreates it. On macOS every path under `/tmp` and `/var` is such a path, which is why the macOS CI legs fail (see TOOL-2).
- **Where:** `src/services/worktree-registry.service.ts:69-70, 77-78`; `src/services/worktree-creation.service.ts:130, 155`; `src/services/git.service.ts:309, 376, 420, 659`. `PathResolutionService.resolveRealPathAsync` already implements "realpath the deepest existing ancestor".
- **Fix:** add one helper (e.g. `sameWorktreePath(a, b)` in `src/utils/path-compare.ts`) that realpaths both sides (deepest existing ancestor, falling back to `path.resolve` for the missing tail) and compares with `pathsEqual`; route all eight sites through it. Canonicalise `worktreeDir`/`bareRepoDir` once in the `GitService` constructor or the config loader so derived paths match what git reports.
- **Done when:** new e2e — config whose `worktreeDir` is under a symlinked directory; the first `--run-once` exits 0 with "1 synced". New unit test — `addWorktree("feature/a", "<link>/wt/feature-a")` on a live worktree returns `already_registered` and moves nothing.

### ENG-2 · P0 · Origin check compares the `insteadOf`-rewritten URL, so affected repositories fail from the second run on [reproduced]

- **Problem:** `git remote get-url origin` applies `url.<base>.insteadOf`; the stored `remote.origin.url` is the configured `repoUrl`. With a rewrite rule in the user's git config (e.g. `url."git@github.com:".insteadOf "https://github.com/"`), the first run clones and every later run reports a mismatch: worktree mode hard-fails (`Existing bare repository … has origin '<rewritten>', expected '<repoUrl>'`), clone mode soft-skips forever with exit 0. The advised remedy (`git remote set-url`) cannot help because the stored URL is already right.
- **Where:** `src/services/bare-repo.service.ts:260`; `src/services/clone-sync/remote-config.ts:211` (callers `clone-sync.service.ts:513`, `clone-bootstrap.ts:240`, `branch-operations.ts:60, 227`).
- **Fix:** read the stored value: `git config --local --get remote.origin.url` (in clone mode, add `url` to the existing `--get-regexp` at `remote-config.ts:19`, which also saves a spawn per tick).
- **Done when:** e2e with `GIT_CONFIG_GLOBAL` holding an `insteadOf` rule that maps a fake https prefix onto a local `file://` remote: two consecutive `--run-once` runs, both modes, report "synced" with no mismatch line.

### ENG-3 · P0 · A preserved diverged/trashed copy is still wired to the live worktree's git admin dir; the printed recovery steps act on the wrong history [reproduced]

- **Problem:** when a diverged worktree is moved aside (to `.trash/<id>/payload`, or `.diverged/<name>` with trash off), its `.git` file keeps `gitdir: <bare>/worktrees/<name>`. The replacement worktree re-registers under the same admin name, so the link resolves again. Inside the copy, `git log` shows origin's tip rather than the user's commits, `git diff origin/<branch>` shows upstream files as deleted, `git push --force-with-lease` prints "Everything up-to-date", and a `git commit` lands on the **live** branch. The tool prints exactly those commands as the recovery steps. The same aliasing happens to a pruned payload once its branch is re-pushed and re-created. Separately, `.diverged-info.json` is written into the payload, so `trash restore` of a diverged entry leaves it untracked in the worktree, which then reads as dirty and never syncs again.
- **Where:** log text `src/services/worktree-mode-sync-runner.ts:1840-1846`; info-file text `:2066-2085` (written into `entry.payloadPath` at `:1982`); `divergeWorktree` `:1958-2050`; `src/services/trash.service.ts:255` (payload keeps `.git`), `:528-545` (restore), `:762-779` (restore already rewrites the payload `.git`), `:800-802` (stale comment); `src/services/trash-migration.service.ts:195-220`; `docs/trash-and-recovery.md:56-58, 95-97` (claims git answers "not a git repository" inside the copy).
- **Fix:** (1) after unregistering, neutralise the copy's top-level `.git` file in both `divergeWorktree` branches and in `TrashService` (rename to e.g. `.git.detached`; restore drops it). (2) Replace the logged and recorded instructions with the route the docs already describe: `git -C <bare> branch <name>-recovered <headOid|keepRef>` and `sync-worktrees trash restore <real id>` (the id is in scope; today the text prints the literal `<id>`). (3) Write `.diverged-info.json` next to `manifest.json` in the container instead of inside the payload, or delete it on restore. (4) Correct the two doc sentences.
- **Done when:** e2e (trash on and off): after a diverged replace, `git -C <copy> rev-parse --git-dir` fails; no log line or info-file text tells the user to run git inside the copy; after `trash restore` of a diverged entry `git status --porcelain` is empty.

### ENG-4 · P0 · The dirty check treats type changes and mixed states as clean [reproduced]

- **Problem:** "is this worktree clean?" is decided from simple-git's `modified/deleted/renamed/created/conflicted/not_added` arrays. simple-git 3.36 has no bucket for ` T` (type change), `MD`, `AD`, `T ` and similar; they appear only in `status.files`. A tracked file replaced by a symlink shows `git status --porcelain` = ` T a` while every array is empty and `isClean()` is `false`. Consequences: the prune decision (`deriveIsClean`) can call such a worktree clean, clone mode fast-forwards over it instead of reporting `clone_dirty_tree`, and the sparse-narrowing and branch-wizard gates pass.
- **Where:** `src/services/worktree-status.service.ts:300-321` (`checkWorktreeStatus`), `:652-663` (`deriveIsClean`), `:667-684` (`describeUncommitted`), `:702-708` (details lists). `git.service.ts:1006` already uses `status.isClean()`.
- **Fix:** decide cleanliness from `status.files` (tracked = any entry that is not `??`; untracked keeps the existing not-ignored logic). Name the otherwise-unbucketed paths in `describeUncommitted` and the details so the skip reason is not empty.
- **Done when:** real-git unit tests for ` T` and `MD`: `checkWorktreeStatus` returns `false`, full status reports not clean with the path named; a clone-mode sync with the remote ahead reports `clone_dirty_tree`.

### ENG-5 · P1 · A locked worktree that diverges is moved anyway (trash off) or fails every tick (trash on) [reviewer-reproduced]

- **Problem:** only the prune path honours `git worktree lock`. With `trash.enabled: false`, `divergeWorktree` renames the directory into `.diverged/` and then `removeWorktree --force` is refused by git ("cannot remove a locked working tree"): the registration is left dangling and locked, no replacement is created, and every later tick fails with "is a missing but locked worktree". With trash on, the worktree is left intact but recorded as `diverged_recovery_failed` (exit 1) on every tick, where prune records the same condition as a `worktree_locked` skip.
- **Where:** `src/services/worktree-mode-sync-runner.ts:1790-1884, 1958-2050`; `src/services/worktree-sync-planner.ts:145-155`.
- **Fix:** before any move in `handleDivergedBranch`/`assessDiverged`, read the lock (carry `locked`/`lockReason` from the worktree listing into `UpdateAction`, no extra spawn) and return a `worktree_locked` skip. Mirror it in the dry-run description.
- **Done when:** e2e — lock a worktree, diverge it, sync with trash on and off: directory in place, a `skipped/worktree_locked` action, `failed === 0`, exit 0.

### ENG-6 · P1 · The update phase has no LFS fallback, so a smudge failure on fast-forward fails every tick [reviewer-reproduced]

- **Problem:** only worktree creation falls back to `GIT_LFS_SKIP_SMUDGE`. In `applyUpdates`, a `merge --ff-only` that fails in the LFS smudge filter becomes `update_failed` inside a `Promise.allSettled` and never reaches `retry()`'s LFS handler. Result: `❌ Failed to update … external filter … failed`, exit 1, identical on every tick, HEAD never moves. The comment at `:821-827` describes this exact defect for the create path, where it was fixed. The sparse re-apply (`applyToWorktree` + `checkoutHead`, `:350-352`) has the same gap.
- **Where:** `src/services/worktree-mode-sync-runner.ts:1704-1747, 833-850, 350-352`; `src/services/git.service.ts:849-853`.
- **Fix:** add an `updateWorktreeWithLfsFallback` shaped like `addWorktreeWithLfsFallback`: on `isLfsError` with skip not yet enabled, call `enableLfsSkipForSync` and retry once. Use it for the sparse re-apply too.
- **Done when:** e2e with a fake `filter.lfs.smudge` that fails unless `GIT_LFS_SKIP_SMUDGE=1`: an update-only tick ends `updated` with an `lfs_skip_enabled` note, exit 0.

### ENG-7 · P1 · `fetchBranch` fetches the tag when origin has a tag and a branch with the same name [reproduced]

- **Problem:** `git fetch origin v1` resolves the short name through `refs/tags/` first: it prints `* tag v1 -> FETCH_HEAD` and leaves `refs/remotes/origin/v1` untouched. MCP `update_worktree` then answers success with `updated: false` forever for such a branch.
- **Where:** `src/services/git.service.ts:545`.
- **Fix:** fetch `refs/heads/${branchName}` (the same file already spells full refs at `:823`).
- **Done when:** e2e — origin has tag `v1` and branch `v1`; push to the branch; after `fetchBranch("v1")` `refs/remotes/origin/v1` equals the remote branch tip.

### ENG-8 · P1 · Sparse-checkout reconcile: mode changes are ignored, widening is called narrowing, and some patterns re-apply every tick [code-checked / reviewer-reproduced]

Three defects in one code path; fix together.

- **(a) Mode change never applied.** `assessSparseAction` compares patterns only (`readCurrent` + `patternsEqual`), so switching `sparseCheckout.mode` between `cone` and `no-cone` with an unchanged include list leaves existing worktrees on the old mode while new worktrees get the new one. Clone mode uses `needsUpdate`, which also compares `core.sparseCheckoutCone`. — `src/services/worktree-mode-sync-runner.ts:387-388`; `src/services/sparse-checkout.service.ts:240-247`.
- **(b) `isNarrowing(["apps/web"], ["apps"])` returns `true`.** It is a set difference on pattern strings, so widening to a parent directory is skipped on every dirty/unpushed worktree as "narrowing", contradicting `docs/sparse-checkout.md:65`. — `sparse-checkout.service.ts:249-270`.
- **(c) Patterns git cannot echo back.** `include: ["."]` or a directory containing a backslash never compares equal to `sparse-checkout list` output (empty, or C-quoted), so every tick re-runs `list`, `init`, `set`, `checkout HEAD` per worktree and logs a false `✅ Sparse-checkout updated`. — `sparse-checkout.service.ts:56-62, 75-89, 209-225`.
- **Fix:** (a) use `needsUpdate` (or compare `readCurrentMode()` with the resolved mode) and treat cone→no-cone as narrowing for the safety gate; (b) in cone mode, a current directory equal to or under any next directory is still covered; (c) reject an entry that normalises to `.` in `coneRuleBroken`, and un-C-quote lines in `readCurrent`.
- **Done when:** e2e for (a): after the mode change the existing worktree has `core.sparseCheckoutCone=false` and the same file set as a fresh one. Unit for (b): `(["apps/web"],["apps"]) → false`, `(["apps"],["apps/web"]) → true`. For (c): `findConeRuleViolations({ include: ["."] })` is non-empty; with a backslash directory the second sync logs no sparse update.

### ENG-9 · P1 · A detached or other-branch checkout at the default-branch path is silently adopted and never updated [reproduced]

- **Problem:** `ensureMainWorktree` matches the anchor by path with no check of `detached`/`branch`. After `git -C wt/main checkout --detach` and a push to `main`, the sync prints "All worktrees are up to date … 1 synced, 0 failed" while `wt/main` stays behind. The planner never plans the default branch, so nothing else reports it.
- **Where:** `src/services/git.service.ts:306-342`.
- **Fix:** return the anchor's state from `ensureMainWorktree`/`ensureAnchorWorktree` (`{ created, detached, branch }`); warn, and have the runner record a skip (e.g. `default_branch_detached` / `default_branch_mismatch`).
- **Done when:** e2e as above: the outcome carries the skip and the summary is not a clean "1 synced".

### ENG-10 · P1 · Every process start fetches twice, and the first fetch is outside the retry policy [code-checked]

- **Problem:** the CLI (`src/index.ts:105` then `:131`) and the TUI scheduler (`sync-cycle-scheduler.ts:337-340`) call `initialize()` and then `sync()`. `GitService.initialize` runs `fetch --all` in the bare repo; the sync immediately runs `fetch --all --prune` in the anchor. That is one extra network round trip per repository per `--run-once`. The first fetch is not wrapped in `retry()`, so with the remote briefly unreachable the run fails after one attempt although `docs/configuration.md:166-185` lists that error as retried. In clone mode the same double call warns twice about an init skip and repeats four git spawns; `pendingInitSkip`/`clonedThisOperation` only ever act on the MCP path.
- **Where:** `src/index.ts:105, 131`; `src/services/sync-cycle-scheduler.ts:337-340`; `src/services/git.service.ts:277-280`; `src/services/worktree-sync.service.ts:757-763` (init sits before `retry(...)` at `:806`).
- **Fix:** drop the pre-`sync()` `initialize()` in the CLI and scheduler (`sync()` already initialises under the lock); move the in-sync init inside the retried closure; in `GitService.initialize` fetch only when the bare repo was just cloned or has no `refs/remotes/origin/*`. Standalone `initialize()` callers (TUI wizard, MCP) already fetch themselves.
- **Done when:** with a PATH shim that logs git spawns, a steady-state `--run-once` shows exactly one `fetch`; with the remote unreachable, `maxAttempts` attempt lines are logged before exit 1; clone mode prints a single skip warning.

### ENG-11 · P1 · The tool's own fetch timeout is not retried; the errno branches can never match [code-checked]

- **Problem:** simple-git's inactivity kill rejects with `GitPluginError { plugin: "timeout", message: "block timeout reached" }` and no `code`. `shouldRetry` matches none of its branches, so a stalled fetch killed by `fetchTimeoutMs` fails on attempt 1, though the docs list timeouts as retried. The `ENOTFOUND/ECONNREFUSED/ETIMEDOUT` checks read `err.code`, which git subprocess errors never carry. `DEFAULT_OPTIONS` (`maxAttempts: "unlimited"`, 600000 ms) disagree with `DEFAULT_CONFIG.RETRY` and are shadowed on the only call site.
- **Where:** `src/utils/retry.ts:33-79`.
- **Fix:** treat `plugin === "timeout"` / "block timeout reached" as retryable; replace the errno branches with the message forms git emits ("Could not resolve host", "Connection timed out", "Connection refused"); make `DEFAULT_OPTIONS` reuse `DEFAULT_CONFIG.RETRY`.
- **Done when:** unit — `retry` with `fn` rejecting `new GitPluginError(undefined, "timeout", "block timeout reached")` makes `maxAttempts` attempts; a "Could not resolve host" rejection is retried.

### ENG-12 · P2 · `trash drop-keep-ref` reports success for a ref that does not exist and skips the `.diverged` protection [code-checked]

- **Problem:** the single-ref path runs `git update-ref -d` directly. That exits 0 for a missing ref, so a typo prints `✅ Deleted <typo>` and writes a `keep_ref_delete success` audit record. It also has no `isKeepRefReserved` check, so it deletes refs that the batch path and force-clean deliberately retain for a `.diverged/<name>` directory. Output mixes full `refs/sync-worktrees/keep/…` paths with the short names the command accepts.
- **Where:** `src/services/worktree-sync.service.ts:576-588` vs `:529-567` and `:378-389`; `src/cli/trash-command.ts:533-541, 565-568`.
- **Fix:** route the single path through the batch logic inside the lock: require the ref in `listKeepRefs()`, apply `isKeepRefReserved`, throw `TrashError` for "no such keep ref" and "retained"; print short names.
- **Done when:** unit — `deleteKeepRef("missing")` rejects and writes no success record; a reserved ref is refused.

### ENG-13 · P2 · A diverged-replace reservation lasts as long as the entry is listed, not until it expires [code-checked]

- **Problem:** `getPendingDivergedBranches` reserves a branch while its trash entry exists; `expiresAt` is only printed. The reaper keeps an expired entry listed in several failure cases (unparseable expiry, keep-ref mint failure, unwritable audit log, payload delete refused), and then the branch never gets a worktree again. The comment directly above says a reservation that cannot expire "is a branch that stops syncing for good".
- **Where:** `src/services/worktree-mode-sync-runner.ts:532-559`.
- **Fix:** reserve only while `Date.parse(manifest.expiresAt) > now`; an unparseable date does not reserve (log once).
- **Done when:** unit — an expired, still-listed entry is absent from the pending set.

### ENG-14 · P2 · `outcome.restore()` on retry erases mutations that already happened [reviewer-traced]

- **Problem:** attempt 1 rebuilds a deleted anchor worktree (`recordCreated`), then the fetch fails with a retryable error; `restore(baseline)` wipes the record and attempt 2 finds the anchor present, so the final outcome never mentions the rebuild. Same for a default-branch switch that created a worktree.
- **Where:** `src/services/worktree-sync.service.ts:785-792`; recorded at `worktree-mode-sync-runner.ts:573, 656`.
- **Fix:** on retry keep fact records (`created`, `removed`, `updated`, `preserved-diverged`) and drop only `skipped`/`noop`/`failed`.
- **Done when:** unit — anchor rebuilt, `fetchAll` rejects once with a retryable error: final outcome has `created: 1`.

### ENG-15 · P3 · Redundant git spawns in status probes [code-checked]

- **Problem / Where:**
  - `worktree-status.service.ts:467` runs `git stash list` once per worktree although the listing is repository-wide (N−1 wasted spawns per status pass).
  - `worktree-status.service.ts:522-540` spawns the identical `rev-list --count <oid>..HEAD` twice when `lastSyncCommit === lastKnownRemoteTip.oid`, which is the normal prune case.
  - `worktree-status.service.ts:749` and `worktree-metadata.service.ts:190` call simple-git `branch()` (`git branch -v -a`, a per-branch subject walk) only to read the current branch.
- **Fix:** share the stash listing through the existing per-repository ref-scan scope; reuse the rev-list result when the oids match; use `symbolic-ref --short -q HEAD`.
- **Done when:** a spawn-count test (PATH shim) shows one `stash list` per repository per pass and no `branch -v -a`.

### ENG-16 · P3 · The LFS "branch-by-branch fetch" fallback is unreachable; `parallelism.maxBranchFetches` controls nothing [code-checked]

- **Problem:** the fallback runs only when `git fetch` fails with a smudge-filter message, and fetch never runs the smudge filter. The runner's own comment at `:821-823` says so. `maxBranchFetches` (schema, docs, example config) only bounds that dead path.
- **Where:** `src/services/worktree-mode-sync-runner.ts:598-609, 1362-1400`; `src/constants.ts:68`; `src/services/config-schema.ts:33-51, 98-101, 352`; `docs/configuration.md:219, 237`; `sync-worktrees.config.example.js:83, 96`.
- **Fix:** delete `fetchBranchByBranch` and the LFS branch in `fetchLatestRemoteData`; keep accepting `maxBranchFetches` but warn it is deprecated and has no effect; remove it from docs, example and the parallelism-peak maths. Keep `GitService.fetchBranch` (MCP uses it).
- **Done when:** `grep -rn fetchBranchByBranch src` is empty; a config with `maxBranchFetches` loads with one deprecation warning.

### ENG-17 · P3 · `--debug` timing table: sparse reconcile is untimed and "Phase 5: Cleanup" times nothing [reviewer-reproduced]

- **Where:** `src/services/worktree-mode-sync-runner.ts:133-137, 314-319, 709-713`.
- **Fix:** time the sparse step as its own phase; remove the no-op Cleanup phase and its event.
- **Done when:** a debug run with `sparseCheckout` shows phase rows that sum to roughly the total.

### ENG-18 · P3 · `.diverged` directory-name fallback strips neither suffix [reviewer-reproduced]

- **Problem:** the regex expects a hex suffix; the generator appends base36 after an 8-hex hash. `2026-11-12-feat-two-2a383c54-mwd95i8ughnw3` yields branch `feat-two-2a383c54-mwd95i8ughnw3`. Only seen when `.diverged-info.json` is unreadable.
- **Where:** `src/services/repository-operations.ts:482` vs `worktree-mode-sync-runner.ts:1993-1996`.
- **Fix:** `(?:-[0-9a-f]{8})?-[0-9a-z]+$`, or show the directory name as-is.
- **Done when:** unit test with a name from the real generator.

---

## Lane CLONE — clone mode

### CLN-1 · P1 · Undo of a rejected fast-forward misses the old path of a rename, leaving the clone permanently dirty [code-checked]

- **Problem:** the undo lists candidate paths with `git diff --name-only -z HEAD origin/<b>`. Rename detection is on, so a rename lists only the new name. If upstream renames a file and adds one whose smudge fails, the half-applied merge is undone except for the deleted old path; status stays ` D old.txt` and every later sync returns `clone_dirty_tree`. `git.service.ts:934-940` passes `--no-renames` for the same reason.
- **Where:** `src/services/clone-sync/fast-forward-undo.ts:86`.
- **Fix:** add `--no-renames`.
- **Done when:** extend `lfs-smudge-clone-merge.e2e.test.ts` with a rename that sorts before the failing path: clean status after the failed tick, fast-forward on the next. Update the unit expectations at `clone-sync.service.test.ts:3136, 3232`.

### CLN-2 · P1 · A long-lived process never recovers a clone deleted out-of-band [reviewer-reproduced]

- **Problem:** `initialized` is set once and never reset. After `rm -rf <worktreeDir>`, every `sync()` on the same service throws `Cannot use simple-git on a directory that does not exist` until the daemon restarts. With the directory present but `.git` gone it soft-skips `clone_head_unreadable` every tick and never re-clones. Worktree mode heals the equivalent case (`git.service.ts:448-477`).
- **Where:** `src/services/clone-sync.service.ts:163, 183-188, 484`.
- **Fix:** at the top of `runSyncAttemptInternal`, probe `<worktreeDir>/.git`; when definitively missing, reset `initialized` and re-run `initialize()`.
- **Done when:** test — sync, remove the directory, sync again on the same service instance: a `created` outcome.

### CLN-3 · P1 · Maintenance `git gc` runs in directories the sync refused to manage [reviewer-reproduced]

- **Problem:** gc runs in `worktreeDir` whenever the sync did not throw. If `worktreeDir` is a linked worktree of some other repository on the wrong branch, init and tick soft-skip (`branch_mismatch`) and then `🧹 Running git gc (maintenance)...` runs against the owning repository. The state file write fails (`ENOTDIR`), so gc is never throttled and repeats every run; with `maintenance.aggressive` that is `gc --prune=now` in a repository the tool said it would not touch. Force-clean's gc has the same gap.
- **Where:** `src/services/git-maintenance.service.ts:79-86, 190`; `src/services/worktree-sync.service.ts:838`, `:417-427`, `:495-498`; guard promise at `clone-sync/git-clients.ts:107-119`.
- **Fix:** in clone mode run maintenance only when the tick obtained the mutating clients (or re-run `assertPrimaryCheckout` in `resolveTarget`); skip when the tick ended in a pre-write skip.
- **Done when:** e2e with a linked worktree on the wrong branch: no "Running git gc" line and unchanged `objects/pack` in the owner.

### CLN-4 · P1 · Clone mode still derives a bare-repo path: a path-less URL crashes, and the TUI measures a stray `.bare/<name>` [code-checked]

- **Problem:** `GitService`'s constructor always computes `bareRepoPath = bareRepoDir || getDefaultBareRepoDir(repoUrl)`. A clone-mode entry with `repoUrl: "https://git.example.com"` (valid per the schema) loads, `doctor` passes, and every sync throws `Git URL has no repository path segment…`; the only remedy the message implies, `bareRepoDir`, is rejected in clone mode. For all clone-mode repositories the path becomes a cwd-relative `.bare/<name>`, which status/metadata reads consult and which the TUI header adds to "Disk Space" (the per-repository figure correctly excludes it).
- **Where:** `src/services/git.service.ts:99`; `src/services/InteractiveUIService.tsx:488, 625-627` (compare `repository-operations.ts:138-141`).
- **Fix:** do not derive a bare path in clone mode (lazy or nullable, with worktree-mode accessors throwing a typed error). Build the TUI disk list from worktree-mode services only, sharing one helper with `getRepositoryDiskUsage`.
- **Done when:** unit — `new WorktreeSyncService({ mode: "clone", repoUrl: "https://git.example.com", worktreeDir })` does not throw; service test with one clone-mode service — the disk measure callback receives `worktreeDir` only.

### CLN-5 · P2 · With `branch` unset the default branch is re-resolved on every process start, contradicting the docs [reviewer-reproduced]

- **Problem:** `docs/clone-mode.md:22-23` says the remote HEAD is "resolved at clone time". The code runs `ls-remote --symref` once per process and caches in memory. If the remote's default changes from `main` to `trunk`, a new process reports `clone is on 'main', expected 'trunk'` and stops syncing (exit 0), while an already-running daemon keeps syncing `main` until restarted. It also costs a network round trip per repository per start, `--dry-run` included.
- **Where:** `src/services/clone-sync.service.ts:115-128`.
- **Fix:** for an existing clone with no configured branch, take the branch the clone tracks; use `ls-remote` only for a fresh clone.
- **Done when:** e2e — clone while HEAD is `main`, move remote HEAD to `trunk`, run again: `main` keeps syncing with no mismatch skip.

### CLN-6 · P2 · `sync --dry-run` plans a clone where the real sync hard-fails [reviewer-reproduced]

- **Problem:** dry run adds a `clone` step whenever `<worktreeDir>/.git` is not "exists". With `worktreeDir` existing, non-empty and not a repository, dry run prints "1 to clone" and the real run fails `Cannot clone into '…': directory exists and is not empty`. A probe result of "unknown" and a clone carrying the incomplete-clone marker are also planned as normal.
- **Where:** `src/services/clone-sync.service.ts:367-376`; real checks at `clone-sync/clone-bootstrap.ts:56-62`, `clone-markers.ts:104-125`.
- **Fix:** run init's read-only destination checks in `planSyncAttempt` and emit a failing step.
- **Done when:** both cases added to `sync-dry-run.e2e.test.ts`.

### CLN-7 · P2 · Clone-mode branch wizard: mislabelled failures, ten useless retries, wrong drift message, false file-copy warning [reviewer-reproduced]

- **(a)** Every `git branch` failure is reported as "already exists", which drives the 10-attempt suffix retry. With local `feat` present, `feat/sub`, `feat/sub-1`, … all fail (`cannot lock ref … 'refs/heads/feat' exists`); each attempt pays an `ls-remote` and a fetch, then the cause is discarded. — `clone-sync/branch-operations.ts:304-316`; loop at `repository-operations.ts:281-320`.
- **(b)** The drift warning quotes the previous in-session branch as what "the config still says" (`featA` instead of the configured `main`). — `clone-sync.service.ts:143-147`; `branch-operations.ts:195-202`.
- **(c)** A failed push rollback never feeds the retry loop's `leftovers` guard, so the message naming the orphaned local branch is dropped. — `repository-operations.ts:264-265` vs `:306`; `branch-operations.ts:385-417`.
- **(d)** With `filesToCopyOnBranchCreate` set, every wizard create warns "Could not find worktrees for file copy" (a clone has one checkout, already on the new branch). — `repository-operations.ts:657-677`.
- **Fix:** (a) use the "already exists" wording only when a suffix can help; a prefix conflict returns a non-retryable error naming the blocking ref. (b) compare and print against `config.branch` or the originally resolved default. (c) one typed error/collector for both modes. (d) return early in `copyBranchFiles` for clone mode.
- **Done when:** real-git unit for (a): one attempt, error names `refs/heads/feat`. Unit for (b): two consecutive drift checkouts, the second message names `main`. Unit for (d): no warning.

### CLN-8 · P2 · Sparse checkout parity with worktree mode [reviewer-traced]

- **(a)** A clone-mode sparse re-apply is never recorded as an update, though dry run and worktree mode both report one. — `clone-sync/sparse.ts:104-106` vs `clone-sync.service.ts:410-416` and `worktree-mode-sync-runner.ts:351-354`.
- **(b)** `sparseCheckout.skipUpdateWhenOutsideSparse` is accepted and shown by `list` for clone mode but only the worktree runner reads it (`worktree-mode-sync-runner.ts:1556`).
- **(c)** A sparse failure recorded earlier in the tick suppresses the `sync_failed` record when the tick later throws, so the outcome shows only the sparse failure. — `worktree-sync.service.ts:815-817`.
- **Fix:** (a) `recordUpdated(branch, worktreeDir, "sparse_checkout")` plus an info line after `applyToWorktree`. (b) implement in the clone tick with `getChangedPathsInRange` + `pathsTouchSparse` before the merge. (c) record the repo-scope failure unless a repo-scope failure already exists.
- **Done when:** `clone-sparse-reapply.e2e.test.ts` asserts the `updated` outcome; unit for (b) with an upstream change outside the cone; unit for (c).

### CLN-9 · P3 · With `sparseCheckout`, the initial clone checks out the whole tree before narrowing [reviewer-reproduced]

- **Problem:** `buildCloneArgs` has no `--no-checkout`. Every out-of-cone file is written and every out-of-cone LFS object downloaded, then deleted; an out-of-cone LFS failure fails the clone. Worktree mode uses `worktree add --no-checkout`.
- **Where:** `src/services/clone-sync/clone-bootstrap.ts:205-229`; `clone-sync/sparse.ts:18-29`.
- **Fix:** when `sparseCheckout` is set, clone with `--no-checkout`, apply the patterns, then check out; keep the incomplete-clone marker around that checkout.
- **Done when:** e2e with a counting smudge filter: out-of-cone paths never smudged, in-cone paths once.

### CLN-10 · P3 · The deepen budget re-runs in full every tick on an unclassifiable shallow clone [reviewer-reproduced]

- **Problem:** with `depth: 1` and the remote force-pushed to unrelated history, every tick runs four fetches (`--depth 1000`, `50`, `200`, `1000`); the object store grew by ~950 objects and two packs per tick. `docs/clone-mode.md:64-66` documents it as a known cost.
- **Where:** `src/services/clone-sync/fetch.ts:226-238, 291-297`.
- **Fix:** skip targets at or below the measured window (`measureLocalHistoryDepth`) and memoise `(HEAD, origin tip, deepenedTo)` so an unchanged pair skips the budget.
- **Done when:** the scenario shows one fetch per tick after the first and a stable `git count-objects -v`.

### CLN-11 · P3 · `switchCloneBranch` has three arms no production caller reaches; one is broken [reviewer-reproduced]

- **Problem:** the only caller is `repository-operations.ts:616` (`allowConfigDrift: true`, after the branch was created locally). The `CLONE_BRANCH_MISMATCH` throw, the same-branch return and the `switch -c <b> --track origin/<b>` arm run only against mocks. On a real single-branch clone the third fails (`cannot set up tracking information`) and leaves the new tree staged on the old branch. The message at `:52` says "then run checkout to converge"; no such command exists.
- **Where:** `src/services/clone-sync/branch-operations.ts:49-56, 83-86, 168-170`.
- **Fix:** delete the unreachable arms and the convergence wording (or fix the third arm and expose a real action — not recommended without a product need).
- **Done when:** typecheck and unit pass; a real-git test covers `checkoutBranch` as the wizard calls it.

---

## Lane CONFIG — configuration and CLI

### CFG-1 · P1 · A repository `name` that cannot become a path segment passes validation, then breaks sync, the TUI and `doctor` [reproduced]

- **Problem:** the schema only requires a non-empty name. `sanitizeNameForPath` later throws for `.`, `..` and Windows device names (`aux`, `con`, `nul`, `com1`…). With `name: "aux"`: `list` shows it as valid; `--run-once` fails `'aux' is a reserved name on Windows`; `doctor` prints `❌ Unhandled error: ConfigValidationError` with a stack (and `doctor --json` writes no JSON); the TUI's unguarded constructor loop aborts for every repository. `init` generates such names from URLs like `…/aux.git`. The package declares `os: ["darwin", "linux"]`.
- **Where:** `src/services/config-schema.ts:506`; `src/utils/sanitize-name.ts:3, 18-24`; `src/utils/lock-path.ts:83`; `src/cli/doctor.ts:416-431, 496`; `src/index.ts:236-239, 368-373`; `src/utils/config-generator.ts:176`.
- **Fix:** drop the `WINDOWS_RESERVED` rule; add a schema refinement on `name` that runs `sanitizeNameForPath` and reports at `repositories[i].name`; in `doctor`, turn a throw from `checkRepository` into a `fail` check.
- **Done when:** schema test — `name: ".."` yields an issue at `repositories[0].name`; `--run-once` with `name: "aux"` syncs; `doctor --json` with a bad name prints a JSON array and exits 1.

### CFG-2 · P1 · Repeated or empty `--filter` / `--config` crash or silently widen the selection [reproduced]

- **Problem:** `list -c cfg -f a -f b` → `❌ Error loading config file: filter.split is not a function` (blames the config). `list -c x -c y` → unhandled `ERR_INVALID_ARG_TYPE` stack. `--filter ""` selects every repository, so `--run-once --filter "$REPO"` with `REPO` unset syncs everything, though a filter that matches nothing is otherwise an error (`src/index.ts:419-424`). `--config ""` is ignored and discovery runs instead.
- **Where:** `src/utils/cli.ts:205-209, 220-224, 261-265, 284-293, 324-333`; `src/utils/config-discovery.ts:72`; `src/services/config-loader.service.ts:785-790, 817`.
- **Fix:** `requiresArg: true` on every `config`/`filter` option; coerce a repeated `--filter` to a comma-joined union; a repeated `--config` is an error; reject the empty string for both.
- **Done when:** `cli.test.ts` cases: `["list","-f","a","-f","b"]` → `filter: "a,b"`; `["--filter",""]` exits 1; repeated `--config` exits 1 with one line.

### CFG-3 · P1 · `branchMaxAge: "0d"` validates and plans the removal of every non-default worktree [reproduced]

- **Problem:** `branchMaxAge` uses the `duration` validator, which accepts zero; the cutoff becomes "now", so every branch is filtered out. `--dry-run` printed `✗ remove feature/x excluded by branchInclude/branchExclude/branchMaxAge … moved to trash` for each. A config like `` `${process.env.DAYS ?? 0}d` `` triggers it. The same file already rejects zero for `maintenance.interval` and blank `branchInclude` patterns.
- **Where:** `src/services/config-schema.ts:238-245, 465`; `src/utils/date-filter.ts:36-38`.
- **Fix:** validate `branchMaxAge` with `positiveDuration` (own message); also reject a duration large enough to produce an Invalid Date cutoff.
- **Done when:** schema test — `"0d"` yields issues at `repositories[0].branchMaxAge` and `defaults.branchMaxAge`.

### CFG-4 · P2 · `sync-worktrees list` reports sparse mode `cone` for a config the sync runs as `no-cone` [reproduced]

- **Problem:** `list` prints `sparse.mode ?? "cone"`; the sync promotes to no-cone when `exclude` is set or an include starts with `!`. For the example config's own `monorepo-with-excludes` entry, `list` and `list --json` say `cone`.
- **Where:** `src/cli/list.ts:115-116` vs `src/services/sparse-checkout.service.ts:21-25` (`modeFor`).
- **Fix:** export `modeFor` (or a `resolveSparseMode`) and use it in `toListedRepository`.
- **Done when:** unit — `{ include: ["/*"], exclude: ["docs"] }` lists `mode: "no-cone"`.

### CFG-5 · P2 · `parallelism.maxRepositories` resolves in the opposite order to every other parallelism field and to the docs [code-checked]

- **Problem:** `maxRepositories` is read top-level first, then `defaults` (`src/index.ts:68-71`, `src/cli/dry-run.ts:37-40`, `config-schema.ts:610`); every other field lets `defaults` override the top level (`config-loader.service.ts:637-643`), which is what `docs/configuration.md:209-210` says. A repository-level `maxRepositories` is accepted and does nothing, yet the comment block `init` writes into every generated config advertises it per repository (`config-generator.ts:24-26`). `src/__tests__/index.daemon.test.ts:192` pins the current order.
- **Fix:** one order everywhere — top level, then `defaults` overriding it; warn on a repository-level `maxRepositories` ("has no effect on a repository"); remove it from the generated per-repo cheatsheet line.
- **Done when:** the daemon test flipped; schema test for the repo-level warning; `config-generator` test that the cheatsheet has no per-repo `maxRepositories`.

### CFG-6 · P2 · `defaults.bareRepoDir`, `defaults.repoUrl`, `defaults.worktreeDir` are accepted, never read and never warned about [reproduced]

- **Problem:** `defaults: { bareRepoDir: "./shared-bare", repoUrl: "…", worktreeDir: "./zzz" }` loads silently and has no effect (the repo still uses `.bare/<name>`). With a clone-mode repo the same key errors as "inherited from defaults.bareRepoDir" although nothing inherits it. The public `SyncWorktreesDefaults` type declares none of the three.
- **Where:** `src/services/config-schema.ts:463, 519-522, 579-585`; `src/services/config-loader.service.ts:495-497`.
- **Fix:** move `bareRepoDir` out of `sharedFields` into `repositorySchema`; drop `repoUrl`/`worktreeDir` from `defaultsSchema` so the existing unknown-key warning fires.
- **Done when:** loader test — `Unknown config key 'bareRepoDir' in defaults` is warned; schema tests updated.

### CFG-7 · P2 · An explicit `undefined` in a nested block resets the inherited value to the built-in default [code-checked]

- **Problem:** nested blocks (`retry`, `parallelism`, `hooks`, `maintenance`, `trash`) merge by object spread, so `retry: { maxAttempts: cond ? 1 : undefined }` on a repository overwrites a global `"unlimited"` with `undefined` → built-in 3. Scalars use `??` and inherit correctly. `src/utils/unknown-config-keys.ts:108-111` names this exact shape as expected input.
- **Where:** `src/services/config-loader.service.ts:625-675`; `src/services/config-schema.ts:615`.
- **Fix:** strip `undefined`-valued keys before each spread (one helper), in the loader and in `checkMergedParallelismPeak`.
- **Done when:** loader test — global `retry.maxAttempts: "unlimited"`, repo `retry: { maxAttempts: undefined }` → resolved `"unlimited"`.

### CFG-8 · P2 · `doctor` uses a deprecated config lookup and gives the wrong hint for `SYNC_WORKTREES_CONFIG` [reproduced]

- **Problem:** with `SYNC_WORKTREES_CONFIG=/nonexistent/x.js`, `doctor` says `Config file not found` and suggests `init --config /nonexistent/x.js`; `list` in the same state says `SYNC_WORKTREES_CONFIG points to a file that does not exist`. `doctor` is the only production caller of the `@deprecated` `findConfigInCwd`. Separately, `ConfigLoaderService.findConfigUpward` duplicates `findConfigUpTree` without the home-directory ceiling and is used only by MCP.
- **Where:** `src/cli/doctor.ts:11, 160, 440, 466-474`; `src/utils/config-generator.ts:237-246`; `src/services/config-loader.service.ts:341-357`; `src/utils/config-discovery.ts:44-58`; `src/mcp/context.ts:233, 304`; `src/constants.ts:169` (comment).
- **Fix:** have `DoctorDeps.findConfig` return `ResolvedConfigPath` from `resolveConfigPath` and branch the hint on `source === "env"`; delete `findConfigInCwd` and its tests; replace `findConfigUpward` with `findConfigUpTree` and fix the comment.
- **Done when:** doctor test with `source: "env"` and a missing file expects a hint naming the variable; `grep -rn "findConfigInCwd\|findConfigUpward" src` is empty.

### CFG-9 · P2 · The `init` wizard refuses repository URLs the loader accepts [code-checked]

- **Problem:** the wizard validates with `/^(https?:\/\/|ssh:\/\/|git@|file:\/\/).*$/`, so `git://host/o/a.git`, `deploy@host:o/b.git` and `/srv/git/c.git` are rejected although all three load from a config file.
- **Where:** `src/utils/interactive.ts:39-40`.
- **Fix:** validate with `isValidGitUrl` (already used by the schema) and reword the message.
- **Done when:** `interactive.test.ts` accepts those three.

### CFG-10 · P2 · The parallelism ceiling counts clone-mode repositories at `maxStatusChecks`, which clone mode never uses [reproduced]

- **Problem:** six `mode: "clone"` repositories with `parallelism: { maxRepositories: 6 }` are rejected: `peak concurrent git processes (120) exceeds safe limit (100) … widest phase (status checks, maxStatusChecks: 20)`. Nothing under `clone-sync` reads `parallelism`.
- **Where:** `src/services/config-schema.ts:361-388, 607-646`.
- **Fix:** give clone-mode entries a small fixed per-repository peak in `checkMergedParallelismPeak`, and skip the per-level check when every repository is clone-mode.
- **Done when:** schema test — the config above loads.

### CFG-11 · P2 · Duplicate-`repoUrl` detection is raw string equality [reproduced]

- **Problem:** `https://example.com/o/r.git` and `https://example.com/o/r` are the same repository, but the duplicate handling (which auto-derives `.bare/<name>`) does not see them as duplicates, so the config fails: `resolve to the same bareRepoDir … Set distinct 'bareRepoDir' values for duplicate repoUrl entries`. The same message fires for two different repositories that share a basename, which are not duplicates.
- **Where:** `src/services/config-loader.service.ts:460-475, 698-705, 732-738`.
- **Fix:** compare with `normalizeRepoUrlForComparison` in `isDuplicateRepoUrl` and `warnOnDuplicateRepoUrls`; reword the collision message for the non-duplicate case.
- **Done when:** loader test — the pair above resolves the second entry to `.bare/<its name>`.

### CFG-12 · P3 · Public types: `SyncWorktreesMaintenanceConfig` is not exported, and the shipped declarations carry internal services [code-checked]

- **Problem:** seven of eight config-block aliases are exported from `src/public-types.ts`; Maintenance is not. Separately, `dist` ships 32 kB of `.d.ts` because the public types share a module with internal types that import `Logger` and `WorktreeStatusResult` (`dist/services/*.d.ts` ship as a result).
- **Where:** `src/public-types.ts:7-18`; `src/types/index.ts:1-2, 521-528`.
- **Fix:** export the alias; move the public config types into a module with no service imports and re-export it from `types/index.ts`.
- **Done when:** `src/types/__tests__/public-config-types.test.ts` imports `SyncWorktreesMaintenanceConfig`; after a build no `dist/services/*.d.ts` remains and `pnpm smoke` passes.

### CFG-13 · P3 · Config docs and comments that no longer match the code [code-checked / reviewer-reproduced]

- `src/utils/config-generator.ts:27` (written into every generated config): "see README for placeholders" — they are in `docs/hooks-and-file-copying.md`. Line 16 says `(d/h/w)`; `m` and `y` are accepted.
- `sync-worktrees.config.example.js:26, 30`: uncommenting the suggested `defaults.branchMaxAge` / `updateExistingWorktrees` makes the file fail (six "not supported when mode is 'clone'" errors from its own clone entries at 419-443).
- `README.md:140`: `init` "walks you through one repository"; the wizard loops on "Add another repository?".
- The `debug` config key is in neither `docs/configuration.md` nor the example config that the README calls "every setting, annotated".
- `src/types/index.ts:249-252` (ships in the `.d.ts`): pin ref path and "reaper runs at the tail of a successful sync" are both out of date (`trash.service.ts:825`; `worktree-sync.service.ts:664`).
- **Done when:** each line is corrected; uncommenting the example's suggested defaults produces a loadable file (move them or scope the comment).

---

## Lane TUI — interactive terminal UI

The TUI reviewer wrote 19 ink-testing-library cases that assert the buggy behaviour; all 19 passed when re-run for this plan. Each task below describes the case to port with the assertion inverted.

### TUI-1 · P0 · A slow load for repository A overwrites the list shown under repository B, so actions hit the wrong repository [reproduced]

- **Problem:** three components apply an async load result unconditionally. Sequence: Enter on repo-A (slow), Esc, Down, Enter on repo-B, then A resolves. The header reads `Repository: repo-B` over A's rows. In the status view, Ctrl-D + `y` then calls `deleteDivergedDirectory(<B's index>, <A's directory>)`. In the branch wizard, the branch is created in B from A's base branch. In the open wizard, B's index is paired with A's path.
- **Where:** `src/components/BranchCreationWizard.tsx:94-129` (Esc at 205-211); `src/components/OpenEditorWizard.tsx:66-80` (Esc at 120-126); `src/components/WorktreeStatusView.tsx:291-321` (Esc at 432-445).
- **Fix:** a load-generation ref per component: increment on every load start and on Esc-back; capture it in the loader; drop the result, the error and the `setLoading(false)` when it no longer matches.
- **Done when:** three tests (one per component) with deferred loaders: after A resolves late the frame still shows B's rows, and no callback receives a mixed index/path pair.

### TUI-2 · P1 · Status view: the selection can rest on the "Diverged Directories" separator or past the end of the list [reproduced]

- **Problem:** a repository with no worktrees but some `.diverged` entries opens with no selected row, no "Ctrl-D to delete" footer, and Ctrl-D/Enter dead until Down is pressed. A filter that matches only diverged entries gives the same state. Deleting the last diverged entry leaves the index past the end.
- **Where:** `src/components/WorktreeStatusView.tsx:273-282, 311, 373-388, 411-415, 494-499, 513-514`.
- **Fix:** never store a non-selectable index: use `selectableIndices[0] ?? 0` wherever `0` is set, derive the effective selection as the nearest selectable index, and clamp after `setDivergedEntries`.
- **Done when:** three tests — a `> ` row and the Ctrl-D footer on open; same after a diverged-only filter; `> <last worktree>` after deleting the last diverged entry.

### TUI-3 · P1 · Open modals keep addressing repositories by array index across a config reload [reproduced]

- **Problem:** the repository list handed to modals is memoised on `repoCount` only ("a signal that a reload changed the list"). A reload that reorders or replaces repositories at the same count does not refresh it, and the modal's stored index now points at a different repository. `o`, `c`, `w` and `/` are not blocked while a reload runs. In the branch wizard this creates and pushes a branch in the wrong repository.
- **Where:** `src/components/App.tsx:440-451`; `src/services/InteractiveUIService.tsx:482, 504`; `src/components/FuzzySwitcher.tsx:106-131, 159-211`.
- **Fix:** emit a monotonically increasing generation on every successful reload and key the memo on it, closing any open picker when it changes. (Sturdier, optional: pass the repository `name` through the modal callbacks and resolve name → service in the operations layer.)
- **Done when:** App test — open `o`, swap the mocked repository list for a same-length reordered one, emit the reload event: the wizard closes or re-lists, and no call goes out with the stale index.

### TUI-4 · P2 · Progress pane: reserves `maxRepositories` rows regardless of need, and shows stale rows from idle-time events [reproduced]

- **(a)** `progressLineCount = max(1, maxProgressLines)` with `maxProgressLines = maxRepositories` (no upper bound in the schema). One repository with `maxRepositories: 8` shows seven blank rows during every sync; with 20 on a 24-row terminal the frame overflows, which makes Ink repaint the whole screen each render. — `src/components/App.tsx:179-186`; `src/components/StatusBar.tsx:109-110, 147-159`; `src/services/InteractiveUIService.tsx:95, 265`.
- **(b)** Progress events that arrive while idle (branch wizard fetch, clone-mode `resolveBranch`) are appended and only cleared on the next `setStatus("idle")`, so the next cycle shows `Progress: [alpha] Resolved default branch 'main'` beside the live row. — `src/components/App.tsx:342, 374-397`.
- **Fix:** (a) `min(maxProgressLines, repoCount, terminalRows − fixed rows)` in App, same number passed to StatusBar. (b) drop `setSyncProgress` while status is not `"syncing"`, and clear entries on the idle→syncing transition and in the three local `setStatus("idle")` catch paths.
- **Done when:** App tests — `repositoryCount: 1, maxProgressLines: 8` at 24 rows shows exactly one `Progress:` row and a frame ≤ 24 rows; an idle-time progress event is absent from the next cycle's frame.

### TUI-5 · P2 · `r` (reload) ignores a changed `parallelism.maxRepositories` [code-checked]

- **Problem:** the limiter, the disk-walk bound and the progress-row count are set once in the constructor; `handleReload` reads only `repositories` from the rebuilt config. Lowering `maxRepositories` to stop hitting a rate-limited remote has no effect until the TUI is restarted. `docs/tui.md` says `r` reloads configuration with no exception.
- **Where:** `src/services/InteractiveUIService.tsx:47-49, 95-97, 406`.
- **Fix:** in `handleReload`, read the value with the precedence CFG-5 settles, set `this.limit.concurrency` (p-limit 7 exposes the setter), update the field and push the new row count to the App.
- **Done when:** service test — reload with a different `maxRepositories`; assert `limit.concurrency`.

### TUI-6 · P2 · A multi-line paste goes verbatim into three filters [reproduced]

- **Problem:** pasting `main\n` (a branch name copied with its newline) into the branch-wizard, open-wizard or status-view filter stores the newline: the match fails with "No matches" and the `Filter:` line renders as two rows. FuzzySwitcher already strips newlines.
- **Where:** `src/components/BranchCreationWizard.tsx:280-285`; `src/components/OpenEditorWizard.tsx:183-188`; `src/components/WorktreeStatusView.tsx:509-515`; compare `FuzzySwitcher.tsx:272`.
- **Fix:** one shared `sanitizePastedFilter(text)` (strip `\r\n`, trim) used by every filter paste site.
- **Done when:** per component — paste `"\u001B[200~main\n\u001B[201~"` and the `main` row is still listed.

### TUI-7 · P2 · Log panel: the fold hint names a key that does nothing, and the scroll position is lost under every modal [reproduced]

- **(a)** When the log is folded for lack of room (not by the user), the line still says `(N entries, l to expand)`; `l` only flips the user's own flag. Only `+` opens it. — `src/components/LogPanel.tsx:217`; `src/components/App.tsx:299-311, 459-464`; `src/components/layout.ts:180`.
- **(b)** The panel is unmounted whenever a modal is open, so `gg` → `?` → Esc returns to the tail; its `isActive` prop is therefore always `true`. — `src/components/App.tsx:458`; `LogPanel.tsx:42, 95, 141, 174`.
- **Fix:** (a) pass the hint as a prop: `"l to expand"` when user-folded, `"+ to expand"` when folded for room. (b) lift the scroll state into App (or keep the panel mounted and hidden) and delete the dead prop.
- **Done when:** App test at 100×12 with five repositories — the hint names a key that changes the frame; App test — scroll to the top, open and close help, the first log line is still visible.

### TUI-8 · P2 · Status bar "Next Sync" shows a time already past for up to a minute [reproduced]

- **Problem:** the next-run time is recomputed by a 60 s interval phased to mount time, not to the cron tick. With `* * * * *` mounted at 10:00:30, at 10:01:15 the bar still reads `Next Sync: 10:01:00`.
- **Where:** `src/components/StatusBar.tsx:73-90`.
- **Fix:** replace the interval with a timeout armed for `next − now + 1 s`, re-armed each time it fires; also recompute when `lastSyncTime` or `status` changes.
- **Done when:** fake-timer test — advance past the tick; the displayed time is in the future.

### TUI-9 · P3 · Wasted work: switcher keeps listing after close; dashboard commits twice per event [reproduced]

- **(a)** FuzzySwitcher queues `git worktree list` for every repository at mount with no cleanup; `/` then Esc still spawns all N (measured: 4 calls at unmount, 20 afterwards). — `src/components/FuzzySwitcher.tsx:108-131`. Fix: return `() => limit.clearQueue()` from the effect and check `mountedRef` before calling the loader.
- **(b)** RepositoryDashboard calls `setNow(Date.now())` in an effect keyed on `rows`, so each publish renders twice, parses every cron expression each time, and re-creates the 15 s interval. — `src/components/RepositoryDashboard.tsx:73, 92-96`. Fix: drive `now` from an interval independent of `rows`; memoise the next-run time per schedule and minute.
- **Done when:** (a) the call count stays ≤ 4 after unmount; (b) a Profiler test shows one commit per `rows` change.

### TUI-10 · P3 · Re-enable the two disabled React lint rules; remove dead UI code; fix docs drift [code-checked / reviewer-reproduced]

- **Lint:** `eslint.config.cjs:84-85` turns off `react-hooks/refs` and `react-hooks/set-state-in-effect` for `src/components`. There are 12 violations; TUI-1, TUI-8 and TUI-9 remove most. Remaining: delete `addLogRef` (`App.tsx:229-230, 402` — `addLog` is already stable); make branch-name validation derived state (`BranchCreationWizard.tsx:155`); delete the no-op clamp at `BranchCreationWizard.tsx:88-92`. Then delete the two overrides.
- **Dead code:**
  - `OpenEditorWizard`'s `OPENING` step can never be painted (set and replaced in one tick): `OpenEditorWizard.tsx:6, 97, 115, 315-319, 334-335, 342, 368`.
  - `App.tsx:269-274` duplicates HelpModal's own close handling.
  - `InteractiveUIService.tsx:253-255` (`if (this.app) this.app.unmount()`) is unreachable; `:149-152` is a 100 ms timer whose comment describes nothing the code does and which is never cleared.
  - Unused re-exports at `App.tsx:34` and `WorktreeStatusView.tsx:10`; `BranchCreationWizard`'s `onComplete(success)` argument is ignored by its only caller.
- **Docs:** `docs/tui.md:24` and `App.tsx:496` describe a `repo-N` fallback for a `name` that is required and unique; `docs/tui.md:131` describes the Open wizard as searching across all repositories (that is the switcher); HelpModal omits Tab in the Open wizard and Ctrl-U in the switcher.
- **Done when:** `pnpm lint` passes with both overrides deleted; typecheck and unit pass.

---

## Lane MCP — MCP server

### MCP-1 · P0 · MCP `sync` never returns with `retry.maxAttempts: "unlimited"`, ignores cancellation, and holds the repository lock [code-checked]

- **Problem:** the handler awaits `service.sync()` with the config's retry policy and never reads the request's abort signal (no `signal` reference anywhere in `src/mcp`). With the remote unreachable and `maxAttempts: "unlimited"` — the value the example config ships — the call never answers. After the client times out or disconnects (stdin closed) the server keeps retrying and refreshing the cross-process lock, so the daemon, the TUI and every other MCP session get `SYNC_IN_PROGRESS` for that repository until the process is killed.
- **Where:** `src/mcp/handlers.ts:629-680`; `src/mcp/context.ts:789-795`; `src/mcp/index.ts:47-51`; `src/utils/retry.ts:122`.
- **Fix:** clamp `retry.maxAttempts` to a small finite number for MCP-built services (`"unlimited"` → 3); pass the request's abort signal into the retry loop; abort in-flight operations and exit when the transport closes.
- **Done when:** stdio test — the config above with a deleted file remote: `sync` returns `isError` within a bound, a following `update_worktree` is not `SYNC_IN_PROGRESS`, and closing stdin ends the process.

### MCP-2 · P0 · Anything the user's config file prints to stdout lands on the JSON-RPC stream [reproduced]

- **Problem:** the config is imported in-process before the transport is set up, and the reload worker inherits stdout. A config whose first line is `console.log("[dotenv] injecting env from .env")` makes that line the first thing on the server's stdout, before the `initialize` response, and again on every `load_config`. Non-message stdout is forbidden on the stdio transport; strict clients drop the connection.
- **Where:** `src/mcp/index.ts:16`; `bin/sync-worktrees-mcp.js:13`; `src/mcp/context.ts:315`; `src/services/config-loader.service.ts:284, 416`.
- **Fix:** in `src/mcp/index.ts`, first capture the real stdout for the transport, then repoint `process.stdout.write` and `console.log/info/debug` to stderr; create the reload worker with `stdout: true` piped to stderr.
- **Done when:** stdio test with a `console.log` config — every stdout line parses as JSON at startup and after two `load_config` calls.

### MCP-3 · P1 · `get_worktree_status` and `list_worktrees` trust a snapshot that never expires [code-checked]

- **Problem:** the non-`fresh` path of `ensureRepoWorktree` validates the path against `entry.discovered`, a plain field cleared only by mutating tools. After a worktree is removed externally (which is what a daemon prune does), `get_worktree_status` on its path still succeeds and returns `isClean: true, canRemove: true` (the status service's answer for a missing path). `list_worktrees` derives `isCurrent` and the `current` label from the same snapshot: it flips after any mutating call, and two repositories can both show `isCurrent: true`. A detached worktree answers "not registered" cold and a real status after `detect_context`.
- **Where:** `src/mcp/handlers.ts:92, 164-180, 423-443, 468-469`; `src/mcp/context.ts:106, 367-372, 766-768, 1143`; `src/services/worktree-status.service.ts:328-342`.
- **Fix:** delete the snapshot branch; always resolve through `service.getWorktrees({ includeDetached: true })` and reject prunable rows. Derive `isCurrent` from the realpath of the launch cwd.
- **Done when:** handler test — snapshot lists a path the fresh listing lacks → error; `isCurrent` identical before and after `invalidateDiscovered()`; a detached worktree gets the same answer cold and warm.

### MCP-4 · P1 · Stale, locked and detached worktrees are reported as clean and safe to remove [reviewer-reproduced]

- **Problem:** `listWorktreesForRepo` narrows rows to `{ path, branch }`. A registration whose directory is gone is listed as `label: "clean", safeToRemove: { safe: true }`, and `update_worktree` on it returns `INTERNAL_ERROR` with a raw `spawn git ENOENT` stack. A locked worktree is reported `safe: true` although sync skips it as `worktree_locked`. A detached worktree is omitted from `list_worktrees` while `detect_context.allWorktrees` shows it.
- **Where:** `src/mcp/handlers.ts:182-204, 400-405, 434-448, 712-713`; `src/mcp/worktree-summary.ts:21-28`; `src/mcp/context.ts:1263-1277`.
- **Fix:** carry `isPrunable`, `locked`, `detached` through the listing. Prunable → `status: null`, label `unknown`, `safe: false` with a reason; locked → `safe: false, reason: "worktree is locked[: …]"`; list detached worktrees with `safe: false, reason: "detached HEAD"`; `update_worktree` on a missing directory throws a typed error.
- **Done when:** real-git tests for the three shapes across `list_worktrees`, `detect_context { includeStatus }` and `update_worktree`.

### MCP-5 · P2 · `detect_context` capabilities contradict what the tools then do [reviewer-reproduced]

- **Problem:** from the workspace root (the directory holding the config) every capability is `available: false` ("No .git file found"), yet `initialize` and `sync` succeed; `docs/mcp.md:15-16` promises the block tells the agent what will work. For a bare repository with no origin URL, `listWorktrees/getStatus/updateWorktree` are `available: true` and all three tools fail with "No repository specified… call detect_context".
- **Where:** `src/mcp/context.ts:563-583, 680, 720-729`; `docs/mcp.md:13-17, 192-194, 205`.
- **Fix:** when the probed path is not a checkout but a repository is selectable, report that entry's base capabilities with a note; register a detected entry without a URL (list/status only) or report those capabilities false; `updateWorktree` is false when `repoUrl === null`.
- **Done when:** context tests for both shapes; an invariant test that no tool whose capability is `available: true` fails with "No repository specified".

### MCP-6 · P2 · The three `readOnlyHint: true` tools rewrite every worktree's git index [reviewer-reproduced]

- **Problem:** `list_worktrees`, `get_worktree_status` and `detect_context { includeStatus }` run `git status` with optional locks, which refreshes and rewrites the index (inode changed after each call). In the documented parallel-agents workflow, one agent's listing can take `index.lock` in another agent's worktree during its `git add`/`commit`. The mechanism to avoid this already exists for dry run (`GIT_OPTIONAL_LOCKS=0`).
- **Where:** `src/mcp/server.ts:153, 178, 202`; `src/mcp/handlers.ts:276, 434, 469`; `src/services/git.service.ts:93-97, 106-113`.
- **Fix:** build MCP status probes with `GIT_OPTIONAL_LOCKS=0`.
- **Done when:** real-git test — index inode and mtime unchanged across the three calls after touching a tracked file.

### MCP-7 · P2 · `create_worktree` fails offline although the code says it works offline [reviewer-reproduced]

- **Problem:** the handler unconditionally fetches before creating; with origin unreachable, `create_worktree { push: false }` returns `INTERNAL_ERROR … Could not read from remote repository`. The comment at `src/services/branch-ref.service.ts:349-351` says "`create_worktree` without a push works offline".
- **Where:** `src/mcp/handlers.ts:558-562`.
- **Fix:** make the fetch best-effort: on failure continue on local refs and add a `warning` that existence was judged from the last fetch.
- **Done when:** test with an unreachable file remote — `success: true` plus the warning.

### MCP-8 · P2 · A config edited after its first successful load is never re-read [reviewer-reproduced]

- **Problem:** re-reading is gated on `configPath === null`; the fingerprint is only used for failed loads. A long-lived session keeps running `sync` under old filters, `worktreeDir` or trash settings until someone calls `load_config`. The CLI re-reads every run and the TUI has `r`.
- **Where:** `src/mcp/context.ts:303, 1318`.
- **Fix:** fingerprint the loaded config; on each tool call compare a cheap `stat` and reload when idle, or attach a `CONFIG_CHANGED` note telling the agent to call `load_config`. Document the behaviour in `docs/mcp.md`.
- **Done when:** context test — edit the file; the next `detect_context` reflects it or carries the note.

### MCP-9 · P1 · Symlinked paths break worktree membership, `isCurrent` and config matching (after ENG-1) [reviewer-reproduced]

- **Problem:** caller-supplied paths are compared lexically. Through a symlinked directory, `detect_context` returns `currentBranch: null` with nothing `isCurrent`; `get_worktree_status`/`update_worktree` answer "not a registered worktree"; a config loaded through the symlink does not match its own repository, which is then listed as an unmanaged `__auto_detected__` sibling. Agents pass `$PWD`, which keeps symlinks; on macOS that includes `/tmp` and `/var`.
- **Where:** `src/mcp/handlers.ts:171, 184`; `src/mcp/context.ts:292, 652-661, 1264-1273`.
- **Fix:** realpath (with the ENG-1 helper) the caller's path in `detectFromPath` and `ensureRepoWorktree`, and the config's `bareRepoDir`/`worktreeDir` when matching.
- **Done when:** tests using a symlinked temp directory for the three calls.

### MCP-10 · P2 · `sync-worktrees init` registers the server with Claude Code at local scope, which the docs say does not work across worktrees [code-checked]

- **Problem:** `init` runs `claude mcp add sync-worktrees -- npx …`. `docs/mcp.md:52-57` tells users to add `--scope user` because a locally scoped server added in one worktree is absent in the next. The comment claims "one entry works across every repo".
- **Where:** `src/utils/mcp-registration.ts:10-12, 52-54`; `README.md:289`; `site/src/content/data/commands.yaml:3`.
- **Fix:** per-client args: `--scope user` for `claude` (and in the manual hint); leave `codex` as is.
- **Done when:** `mcp-registration.test.ts` asserts `["mcp","add","--scope","user","sync-worktrees","--",…]` for `claude`.

### MCP-11 · P2 · Context bookkeeping: duplicate entries after `load_config`, false `localReady`, silent refused clone [reviewer-reproduced]

- **(a)** A detected (`__auto_detected__`) entry survives a `load_config` that covers the same repository: both are listed and a second `WorktreeSyncService` stays alive for one repository. — `src/mcp/context.ts:258-276, 478-486`. Fix: drop every detected entry that `findConfiguredEntryForDetected` matches.
- **(b)** `configuredRepositories[].localReady` is `true` for an empty bare directory (the lock creates the directory before any clone). — `src/mcp/context.ts:1030-1032`. Fix: probe `<bareRepoDir>/HEAD`.
- **(c)** MCP `initialize` returns `success: true` for a clone it refused to adopt (wrong branch/origin), and its description is worktree-only. — `src/mcp/handlers.ts:735-746`; `src/mcp/server.ts:300`; `docs/mcp.md:219`. Fix: include `skips` in the response as `sync` does; reword for both modes.
- **Done when:** context tests for (a) and (b); handler test for (c) with a clone on the wrong branch.

### MCP-12 · P3 · MCP docs and tool descriptions that do not match behaviour [reviewer-reproduced]

- `src/mcp/server.ts:194-197`: `includeDetails` "Default: false (counts only)" — with `false` there is no `details` at all.
- `docs/mcp.md:235`: "Every failed call returns `{ error: true, code, message }`" — input-validation failures are plain text and an unknown tool is JSON-RPC `-32602`.
- `docs/mcp.md:246-248`: "`GIT_*` from a git failure" — clone/fetch/merge/push failures and all user errors (unknown repo, invalid branch name, not a registered worktree) surface as `INTERNAL_ERROR`, so "branch on `code`" is not possible. Either classify them or narrow the docs.
- `docs/mcp.md:230-231`: the resource is "never cached" — it is served from a 5 s cache.
- `src/mcp/utils.ts:77`: any truthy `DEBUG` adds a `stack` to every error payload; undocumented, and `DEBUG` is a generic variable. Use a namespaced variable or document it.
- `src/mcp/server.ts:343`: "Preconditions: load_config called" is false.
- `docs/mcp.md:205`: "a single repository is selected" — the first `detect_context` shows it `isCurrent: false`.
- `load_config`/`set_current_repository` show a placeholder `worktreeDir` where `detect_context` says `null` (`context.ts:704, 981`).
- `src/mcp/__tests__/server.test.ts:266`: the title says "rejects a legacy handshake"; the body asserts it is served.
- **Done when:** texts corrected; `server.test.ts` pins the descriptions.

### MCP-13 · P3 · Redundant work and dead code in handlers (after ENG-10) [reviewer-reproduced]

- First `create_worktree` in a process: `fetch --all` (initialize) immediately followed by `fetch --all --prune`, then three consecutive `git worktree list`. — `src/mcp/handlers.ts:558-562, 570-571, 596, 694-712`. Fix: skip the handler's fetch when initialize just ran in the same operation; pass the listing from `resolveNewWorktreePath` to the collision check.
- `src/mcp/handlers.ts:648-654, 673`: `result.outcome ?? createEmptySyncOutcome(…)` and `outcome.durationMs ?? duration` are reachable only from test mocks that omit `outcome`. Delete both and `createEmptySyncOutcome`; make the mocks return an outcome.
- `src/mcp/context.ts:239-256` re-implements `ConfigLoaderService.buildRepositories` step for step; call it.
- **Done when:** a unit test asserts `fetchAll` is not called when init ran in the same operation; typecheck and unit pass.

---

## Lane TRASH — trash, recovery, hooks, file copy

### TR-1 · P0 · Hook placeholder substitution corrupts the command when a value contains `$` [reproduced]

- **Problem:** placeholders are substituted with chained `.replaceAll(placeholder, shellEscape(value))`. A string replacement still interprets `$'`, `` $` ``, `$&` and `$$`, and each pass rescans the previous output. Branch `fix/price$` (a valid branch name) with `echo {BRANCH_NAME} && echo done` resolves to `echo 'fix/price && echo done && echo done` — an unterminated quote, with the rest of the command pulled inside the argument. A password `pa$$word` in `{REPO_URL}` becomes `pa$word`. A value that contains a later placeholder is re-expanded outside its quotes.
- **Where:** `src/services/hook-execution.service.ts:151-158`.
- **Fix:** one pass with a function replacer: `command.replace(/\{(BRANCH_NAME|WORKTREE_PATH|REPO_NAME|BASE_BRANCH|REPO_URL)\}/g, (_m, k) => shellEscape(values[k]))`.
- **Done when:** rows added to the `it.each` at `src/services/__tests__/hook-execution.service.test.ts:243` for `fix/price$`, `pa$$word`, `a$&b` and `a{REPO_URL}b`, each asserting the exact resolved command.

### TR-2 · P1 · Directory sizing fails on any unreadable file and returns 0 for a symlinked directory [code-checked]

- **Problem:** `calculateDirectorySize` rejects whenever `du` exits non-zero, even though `du` prints a usable total and exits 1 when one subdirectory is unreadable (e.g. root-owned Docker output, which `trash-container.ts:33` itself names). A trash payload like that is never sized: `sizeBytes` stays `null`, so a full `du` of it re-runs at the tail of every sync for the whole retention window, it never counts toward `warnSizeBytes`, and it lists as "—". The TUI header silently drops the directory (`.catch(() => 0)`). `du -sk <symlink>` prints 0, so a symlinked `worktreeDir`/`bareRepoDir` shows as 0 B.
- **Where:** `src/utils/disk-space.ts:12-28, 74`; `src/services/trash.service.ts:358-359, 376-382`; `src/services/worktree-sync.service.ts:857, 933-940`.
- **Fix:** when `err.code === 1` and stdout matches `/^(\d+)\s/`, resolve with the parsed figure; add `-H` (or realpath the argument); do not re-walk a payload that already failed in this process.
- **Done when:** unit with mocked `execFile` returning `(err{code:1}, "308\t/p\n")` → 315392; real-fs test that a symlink measures the same as its target; a failing `du` is not invoked again by a second `listEntriesWithSizes`.

### TR-3 · P1 · A kill during `trashDirectory` leaves a container the tool can never list or reap [code-checked]

- **Problem:** for keep-on-reap entries the first manifest is written with `keepPinOnReap: true, pinRef: null`. The manifest validator rejects exactly that combination (`trash.service.ts:876`). The comment at `:180-183` promises "a crash in between leaves a valid (payload-less) entry that ages out normally". A SIGKILL/OOM while the bundle is being created leaves `.trash/<id>` invalid forever, and its pin ref keeps objects alive because the orphan sweep keys on the container existing.
- **Where:** `src/services/trash.service.ts:159-185, 195-254, 876`.
- **Fix:** write the first manifest with `keepPinOnReap: false` and set it in the second write at `:250-254`.
- **Done when:** unit — capture the first `writeManifest` (or hang `createBundleFromRef`), then a fresh `listEntries()` returns the entry under `entries`, not `invalid`.

### TR-4 · P1 · `sync-worktrees trash` prints "Unhandled error" stacks for two expected conditions [reproduced / reviewer-reproduced]

- **(a)** A configured repository that has never been synced: `trash` → `❌ Unhandled error: GitConstructError: Cannot use simple-git on a directory that does not exist`, exit 128. `drop-keep-ref` and `drop-all-keep-refs` take the same path. — `src/cli/trash-command.ts:523-524` → `worktree-sync.service.ts:308-310` → `branch-ref.service.ts:135`. [reproduced]
- **(b)** `trash restore` when git refuses the branch (e.g. `refs/heads/topic/sub` exists and the entry is `topic`): raw `GitError: cannot lock ref`. `createBranchAt` at `trash.service.ts:661` sits outside the `try` that starts at `:666`, so it is not wrapped in `TrashOperationError`. [reviewer-reproduced]
- **Fix:** (a) probe `<bare>/HEAD` in `executeTrash`: print "No trash entries." for a listing, throw `TrashCliError("… has not been synced yet")` otherwise. (b) move `createBranchAt` inside the `try`.
- **Done when:** e2e on a fresh config — one line, no stack; unit — `createBranchAt` rejecting yields `TrashOperationError` and the payload is still in the container.

### TR-5 · P2 · Recovery paths users are not told about: restored prune entries are re-pruned, and `commits.bundle` is undocumented [reviewer-reproduced]

- **(a)** Restoring a `prune` entry (remote branch deleted) is undone by the next sync, which moves the worktree to trash again. Neither the restore output nor `docs/trash-and-recovery.md:20, 242-248` says so. Fix: when `trackRemoteBranchIfExists` returns false (`trash.service.ts:684`), warn that the next sync will prune it again unless it has uncommitted/unpushed work or the remote branch returns; add the sentence to the docs.
- **(b)** Every keep-on-reap removal writes `commits.bundle` (a `rev-list --count` plus `git bundle create` under the repository lock; a bundle failure aborts the removal). Nothing reads it and no doc mentions it. Fix: document it and the verified recovery command, `git -C <bare> fetch <container>/commits.bundle '<pinRef>:refs/heads/<name>-recovered'`, and add it to the layout block at `docs/trash-and-recovery.md:105-113`.
- **Done when:** unit asserts the restore warning; docs updated.

### TR-6 · P2 · Empty or manifest-less trash containers left by the tool's own crash windows are never cleaned [reviewer-traced]

- **Problem:** a kill between `mkdir` and the first manifest leaves an empty container; a recursive `rm` unlinks `manifest.json` before a refused `rmdir`. The reaper only warns about them (every tick), and purge/force-clean act on valid ids only.
- **Where:** `src/services/trash.service.ts:157-185`; `src/utils/trash-container.ts:94-100`; `src/services/trash-reaper.service.ts:139-145`.
- **Fix:** in the reaper, `fs.rmdir` (non-recursive) an invalid container that is empty or holds only `*.tmp` leftovers.
- **Done when:** unit — an empty `.trash/x` is gone after a reap; a non-empty manifest-less directory is untouched.

### TR-7 · P2 · Hooks in one array run concurrently with unattributed, byte-split output [reviewer-reproduced]

- **Problem:** `onBranchCreated: ["sleep 0.6; echo first", "echo second"]` prints "second" first; `["pnpm install", "pnpm build"]` races. The docs do not say commands run in parallel. Output is decoded per chunk (`data.toString().trim()`), so a multi-byte character split across two writes becomes `�`, and lines carry no command name.
- **Where:** `src/services/hook-execution.service.ts:48-51, 212-226`; `src/services/branch-created-actions.service.ts:103-104`; `docs/hooks-and-file-copying.md:16-18`.
- **Fix:** run the array sequentially in order (stop at the first failure, as the timeout/quit semantics already documented allow); `setEncoding("utf8")` on both streams and line-buffer; prefix each line with the command. Document the order and that placeholders arrive single-quoted.
- **Done when:** unit — the two-command array above prints "first" then "second"; a split "é" arrives intact.

### TR-8 · P3 · Small correctness and efficiency items [reviewer-reproduced / reviewer-traced]

- `src/utils/atomic-write.ts:6-8, 23-25`: the temp name is `<file>.<pid>.<Date.now()>.tmp`, so two writes of one file in the same millisecond collide (three concurrent writes gave one success and two `ENOENT … rename`). The EXDEV fallback is unreachable (the temp file is a sibling) and would be non-atomic. Fix: add a counter or random suffix; delete the EXDEV branch.
- `src/services/file-copy.service.ts:145-154, 175-179`: `realpathSync` on every walked directory whenever `excludeDirs` is set (always, in production): `**/.env` over 18,000 directories took 1317 ms instead of 600 ms, on the TUI's event loop. Fix: canonicalise only symlinks and their descendants.
- `src/services/trash-migration.service.ts:59, 113-116, 142`: an un-adoptable legacy entry logs the same warning every tick. Fix: the warn-once set the reaper already uses (`trash-reaper.service.ts:48-55`).
- Stale comments: `trash-reaper.service.ts:43-44` ("tail of a successful sync" — it runs after failed ones too); `trash.service.ts:409` ("prune and manual removal"); `trash.service.ts:735` ("the README's manual recipe" — it is in `docs/trash-and-recovery.md:250-261`); `removal-audit.service.ts:32-33` claims every destructive operation is audited, but the trash-disabled `rmdir`/quarantine at `worktree-creation.service.ts:617-642` writes no record (add the record or narrow the claim).
- **Done when:** unit — three concurrent `atomicWriteFile` calls on one path all resolve; the legacy warning is logged once across two ticks.

---

## Lane TOOLING — CI, build, docs, site, test infrastructure

### TOOL-2 · P1 · macOS test legs fail on every run and CI reports them green (after ENG-1 and MCP-9) [reviewer-reproduced]

- **Problem:** `continue-on-error: ${{ matrix.os == 'macos-latest' }}` on the test steps. On PR #172 the macOS job logged `12 failed | 196 passed` files, `17 failed` tests, and concluded `success`; the nightly at this commit shows the same. The count has grown since the mask was added (15 tests → 17). `package.json` declares darwin as supported. Most failures are ENG-1's symlink bug (`/var` → `/private/var`). Three are separate: `concurrent-runs.e2e.test.ts:285` (git shim: `syntax error near unexpected token 'newline'`), a worktree-naming case (`cannot lock ref 'refs/heads/MAIN'` on a case-insensitive filesystem), and `unshallow-inactivity-timeout.e2e.test.ts:151`. The macOS coverage upload also finds no files.
- **Where:** `.github/workflows/pr.yml:112`; `.github/workflows/nightly.yml:45`; `docs/internal/FOLLOW-UPS.md:2145-2150` (FU-CI-1).
- **Fix:** after ENG-1 and MCP-9, fix the three remaining darwin failures (needs a macOS runner — iterate in CI), delete both `continue-on-error` lines, gate the coverage upload on `steps.tests.outcome == 'success'`, and update FU-CI-1.
- **Done when:** the macOS job log shows no `failed` and the job passes without the mask.

### TOOL-3 · P2 · Two doc pages are missing from every index, the site does not redeploy on docs changes, and it documents a legacy flag [code-checked]

- **Problem:** `docs/doctor.md` and `docs/dry-run.md` are listed in `docs/README.md` only: the README's Documentation line, `llms.txt` and `llms-full.txt` list seven of nine pages. `deploy-site.yml` triggers on `site/**`, two demo assets and `README.md`, not on `docs/**` (which `llms-full.txt` embeds) nor on `assets/launch.mp4`/`launch-poster.jpg` (which the build copies). The site uses `--runOnce` in four places; `--help` lists only `--run-once`, and the README calls camelCase a spelling "from earlier releases". `README.md:156` omits `doctor` from the commands that honour `$SYNC_WORKTREES_CONFIG`.
- **Where:** `README.md:156, 405-406`; `site/src/pages/llms.txt.ts:24-31`; `site/src/pages/llms-full.txt.ts:4-24, 70`; `.github/workflows/deploy-site.yml:5-18`; `site/src/content/data/commands.yaml:6`; `site/src/components/QuickStart.astro:24`; `site/src/content/faq/06-cron.md:6`.
- **Fix:** add both pages to the three lists; add `docs/**` and the two launch assets to both `paths:` blocks; replace `--runOnce` with `--run-once`; add `doctor` to README:156.
- **Done when:** `grep -c "doctor.md\|dry-run.md" site/src/pages/llms*.ts` is non-zero; `grep -rn -- "--runOnce" site/src` is empty.

### TOOL-4 · P2 · Half of the "e2e" project never touches the build [reviewer-reproduced]

- **Problem:** `vitest.config.ts:7` says the e2e directory holds suites that "spawn the bundled CLI (dist/)". 24 of its 50 files reference neither `dist` nor `bin/sync-worktrees`; they import services from `src/` and use real git. So `pnpm test:unit` silently skips 24 source-level suites, and they wait on a build they do not use. Four files there also lack the `.e2e.` infix.
- **Where:** `vitest.config.ts:7-8, 41-56`; `README.md:417-418`; `src/__tests__/e2e/*`. List them with: `for f in src/__tests__/e2e/*.ts; do grep -qE "dist|bin/sync-worktrees" $f || echo $f; done`.
- **Fix:** add a third project (`integration`: real git, no build) for those 24 files and include it in `test:unit`; extend `unit-project-build-free.test.ts` to assert every file left in the e2e directory references the build output. Update the README test section.
- **Done when:** `pnpm test:unit` runs the integration project without a `dist/`; the guard test passes.

### TOOL-5 · P3 · Dead test infrastructure and config patterns that match nothing [reproduced]

- **NUL bytes:** `src/services/__tests__/branch-ref.service.test.ts` contains 20 raw NUL bytes from line 256, so `grep`/ripgrep treat it as binary and stop reading it. Replace each with the `\0` escape (production code already uses the escape).
- **Unused files:** `src/__tests__/fixtures/git-responses.ts` and `src/__tests__/helpers/mock-helpers.ts` have no importer.
- **Unused exports** in `src/__tests__/test-utils.ts`: `mockFileSystem`, `createBranchListOutput`, `withTempDirectory`, `buildGitLogResponse`.
- **Skips that do nothing:** `src/__tests__/e2e/config-file.e2e.test.ts:103` is a hard `it.skip` for a network clone not behind `RUN_NETWORK_E2E`, so it runs nowhere (delete it or convert to `itNetwork`). `SKIP_E2E_TESTS` is read in three e2e files and set by nothing. `ssh-prompt-disabled.e2e.test.ts:25` guards on `win32` for a package that cannot install on Windows.
- **Patterns matching nothing:** `tsconfig.spec.json` (`*.spec.ts(x)`, `__mocks__`, `src/test-setup.ts`); `tsconfig.json:25` (test/spec excludes — no test lives outside `__tests__/`); `eslint.config.cjs:9, 11`; `vitest.config.ts:21` (`**/*.skip`), `:27` (`__mocks__`), `:59-63` (the `~` alias has no users and no matching tsconfig `paths`, so using it would fail `tsc`).
- **package.json / ignore files:** `test:e2e:local` is a plain alias of `test:e2e`; `pnpm.onlyBuiltDependencies` lists `unrs-resolver`, which is not in the lockfile; `.gitignore:8` (`.nyc_output/`, coverage is v8); `.prettierignore:9` names a `TODO` file that no longer exists.
- **Done when:** `grep -rlP "\x00" src` is empty; `pnpm typecheck && pnpm lint && pnpm test` pass; `pnpm exec tsc --noEmit -p tsconfig.spec.json --listFilesOnly | grep -vc node_modules` is unchanged (339); `grep -rn "SKIP_E2E_TESTS" src` is empty.

### TOOL-6 · P3 · Site: unused dependencies, dead code, no type check, a tracked file the build rewrites [reviewer-traced]

- `site/package.json`: `@astrojs/mdx` is registered but there are no `.mdx` files; `@playwright/test` has no test, config or script; `@astrojs/check` and `typescript` are installed but nothing runs `astro check`, and the root linter ignores `site/` (hence `as any` in `AgentIntegration.astro:71` and `QuickStart.astro:52`).
- `Icon.astro`: 8 of 16 variants unused. `content.config.ts:66`: a required `icon` field no component reads. `globals.css:26-54` and `tailwind.config.mjs:6, 45-59`: unused classes, `darkMode`, animations.
- `site/public/og-image.png` is tracked, yet `prebuild` regenerates it on every build (`docs/internal/plan.md:47-49` records the manual `git checkout --` workaround).
- FAQ file prefixes do not match their `order:` (01→2, 03→7, 07→1).
- **Fix:** drop mdx and playwright; add a `check` script and a CI step in `deploy-site.yml`; prune the icons, field and CSS; gitignore the og image or stop regenerating it; renumber the FAQ files.
- **Done when:** `cd site && npm ci && npm run check && npm run build` succeeds and `git status` is clean afterwards.

### TOOL-7 · P3 · Workflow and lint hygiene [code-checked / reviewer-reproduced]

- `.github/workflows/demo.yml:29` uses `actions/checkout@v4` (every other workflow uses `@v7`).
- `.github/actions/setup-node-pnpm/action.yml:24`: `pnpm/action-setup@v4` produces a "Node.js 20 is deprecated" warning on every job; move to a Node 24 major.
- `eslint.config.cjs:16` does not ignore `tmp-e2e-*/` or `.mcp-stdio-test-*/` (both in `.gitignore` and `.prettierignore`), so `pnpm lint` during or after an interrupted e2e run lints scratch repositories.
- `vitest.config.ts:27` excludes `src/index.ts` and `src/utils/cli.ts` from coverage although five suites and a 50-test file cover them; the thresholds say nothing about the CLI entry. Remove the excludes and re-baseline the thresholds.
- `src/__tests__/utils/retry.test.ts` is the only util test outside `src/utils/__tests__/`; move it.
- **Done when:** the Node 20 warning is gone from a job log; `pnpm test:coverage` lists both files and passes.

### TOOL-8 · P3 · Internal records and alt text that reference things that moved [reviewer-traced]

- `docs/internal/FOLLOW-UPS.md` cites `TODO.md` throughout (it is now `6.0.0-review.md`): add one line under "How to read it".
- `docs/internal/plan.md` says "the seven `docs/` pages"; there are nine.
- `README.md:19-20` and `site/src/components/Hero.astro:108`: the demo alt text omits the switcher, `--dry-run` and `cd` steps that `demo/story.tape` records.
- After this plan's tasks land, mark the FOLLOW-UPS entries they close (the task text names them where the reviewer cited one).

---

## Lane LAST

### DEAD-1 · P3 · Dead-code sweep in `src/` [reproduced]

Run after every other lane has merged. Each symbol below was checked with a production-only unused-export scan plus a grep over `src`, `bin`, `scripts`, `docs` and `site`: no production caller. Delete the symbol **and** the tests that exercise only it.

- **No references at all:** `isRepositoryMode` (`src/utils/repo-mode.ts:8`); `GIT_CONSTANTS.REMOTE_NAME` (`src/constants.ts:3`); `ERROR_MESSAGES.ALREADY_REGISTERED` (`src/constants.ts:99` — `worktree-creation.service.ts:29` redeclares the literal; use the constant or delete it); `WorktreeStatus` interface (`src/types/index.ts:387-391`); `getErrorMessage` re-export (`src/utils/lfs-error.ts:1-5`); `SyncHistoryEntry.action: "fetched"` (`src/types/sync-metadata.ts:26`).
- **Referenced only by their own tests:**
  - `src/errors/index.ts:165-175`: `isFastForwardError`, `isNoUpstreamError`, the `isLfsError` re-export, and `ERROR_MESSAGES.NO_UPSTREAM`.
  - `Logger.withPassthrough` and `defaultConsoleOutput` (`src/services/logger.service.ts:129-156`). Also `formatMessage`'s `%s` varargs (`:117-123`): no production call passes extra arguments, and `replace("%s", String(arg))` mis-expands `$&` in the argument.
  - `SyncCycleScheduler.registerCronJob` (`src/services/sync-cycle-scheduler.ts:135`).
  - `WorktreeMetadataService.deleteMetadata`, `updateLastSync`, `createInitialMetadata` (`src/services/worktree-metadata.service.ts:115, 141, 276`) — name-keyed twins of the `*FromPath` methods production uses.
  - `WorktreeStatusService.hasModifiedSubmodules`, `validateWorktreeForRemoval` (`src/services/worktree-status.service.ts:834, 857`); `WorktreeSnapshot.exists` (`:211, 571`, written and never read).
  - `GitService.remoteBranchExists` (`src/services/git.service.ts:732`).
  - `TrashSummary.soonestExpiresAt` (`src/services/trash.service.ts:69, 79, 87-89`).
  - `RemovalAuditAction` members `orphan_delete`, `orphan_quarantine`, `manual_remove` (`src/services/removal-audit.service.ts:8, 9, 13`). Keep `TrashReason "manual"` in the manifest validator: older versions may have written it.
- **Unreachable branches:**
  - `src/services/worktree-sync-planner.ts:42-72`: `SyncPlan.warnings` (always `[]`), the `SyncAction` type, the `skip-sparse` variant; with them the guards at `worktree-mode-sync-runner.ts:238, 326`.
  - `src/services/repository-operations.ts:435-445`: the `typeof getWorktrees === "function"` probe and its fallback.
  - `src/services/worktree-sync.service.ts:780`: `this.cloneSyncService !== undefined` is always true (the field is `| null`); should be `!== null`. `:484`: `(await fs.readdir(...)) ?? []`.
  - `src/services/clone-sync.service.ts:183-188` (the `!this.initialized` branch, unreachable from `sync()`), `:584-593` (`skipStep` fallback arm); `:43-44` re-exports used only by one test.
  - `src/services/lfs-verification.service.ts:157-161` with `GIT_CONSTANTS.GIT_NO_MATCH_EXIT` (`src/constants.ts:25-28`): simple-git resolves `git grep`'s exit 1 as `""`, so the catch never sees "nothing matched". Make the catch `return true` and drop the constant.
- **Re-exports only tests import from that path** (repoint the tests): `ConfigFileExistsError` from `src/utils/config-generator.ts:11`; `CLONE_MODE_CONFLICTING_FIELDS`, `computeParallelismPeak`, `ParallelismPeak` from `src/services/config-loader.service.ts:20-23`.
- **Write-only data:** `syncHistory` and `createdFrom` in worktree metadata have no production reader. Decide: surface them (TUI/MCP) or stop writing them. Not a blind delete — existing metadata files carry the fields.
- **Keep (test seams, deliberate):** `WorktreeSyncService.getLastOutcome`, `InteractiveUIService.getEvents`, `GitClientCache.countFor/size`, `resetGitLfsProbeForTests`, `resetWorktreeListCapabilityForTests`.
- **Done when:** `pnpm typecheck && pnpm lint && pnpm test && pnpm smoke` pass; the tarball size printed by `pnpm smoke` is lower than before the task.

---

## Not in the plan

### Suspected, not confirmed

These were raised by a reviewer and not reproduced. Treat as leads to investigate, not as work items.

- **Anchor moved to trash:** `git checkout -b tmp` inside the default-branch worktree makes the next sync move it to trash and rebuild it next tick (reproduced; intent unclear, so not specified as a bug).
- **Status probes outside MCP also take optional index locks** in worktrees the user is editing (daemon/TUI); no collision reproduced.
- **`--run-once` signal handling:** SIGTERM exits at once with code 130 and no cleanup function; effect on in-flight git children and half-done trash moves untested. Same for the MCP server's SIGTERM.
- **First sync after a fresh clone runs `git gc`** because no maintenance state exists yet; cost on a large repository not measured.
- **`classifyWithDeepening` fetches without `fetchWithRecovery`**, so a branch deleted mid-tick may hard-fail instead of skipping.
- **`origin/<branch>` shorthand** in merge/switch/branch can be shadowed by a local ref literally named `origin/<b>`.
- **Unpushed probe uses `--not --remotes`** while `branch-ref.service.ts` argues for `--glob=refs/remotes/origin/`; no data-loss path found.
- **A prunable registration whose directory still exists** is treated as a live worktree and never heals.
- **`detectDefaultBranch` never notices a remote HEAD change** while the old default still exists.
- **`sparse-checkout init` runs before `set`:** a failing `set` on a previously full checkout may leave it stripped to the cone root.
- **`AppEventEmitter` docblock says every string is scrubbed, but array payloads are skipped;** no unredacted producer exists today.
- **`gg` delivered as one stdin chunk** does nothing in the log panel; whether a real terminal coalesces the keys is untested.
- **`commandExists` shells out to `which`,** absent on some minimal images.
- **Cross-level retry merge can violate `initialDelayMs <= maxDelayMs`** (the rule is checked per block).
- **`// @ts-check` in a generated config** probably cannot resolve the types on a global install.
- **`formatBytes` prints an `undefined` unit** below 1 B or at 1 PiB and above.
- **A very large `trash.retentionDays`** would make `expiresAt.toISOString()` throw.
- **Release PRs get no CI:** all "PR Checks" runs on `changeset-release/main` conclude `failure` with zero jobs; probably merge-before-start.
- **Five Dependabot PRs (#165–#169) have been open since 2026-10-02,** including simple-git 4, astro 7 and vite 8.

### Checked and dismissed

- `@types/yargs@17` alongside `yargs@18`: needed and used (yargs 18 ships no types for the root import).
- `bin/node-version.js` saying "use sync-worktrees@5 on Node 22": correct, 6.0.0 raised the floor.
- esbuild `target: "node22"` with `engines >= 24`: deliberate, documented in `pr.yml`.
- `dist/services` and `dist/types` in the tarball: declarations reachable from the public types (CFG-12 shrinks them; they are not stale output).
- Every runtime dependency is imported; no transitive-only imports.
- `site/package-lock.json` (npm) beside root pnpm: deliberate; the site workflow runs `npm ci`.
- Trash migration (`trash-migration.service.ts`) is live, not legacy-only: the layouts it adopts are still produced whenever `trash.enabled: false`.
- MCP: input schemas match handlers; about 60 real calls returned schema-valid structured output; no credential leaked through any response, error or log with a token-bearing URL.
- TUI: every timer, interval and emitter subscription is cleaned up (the one gap is TUI-9a); no git or filesystem call is reachable from a render path; documented keys match the handlers except as listed in TUI-10.
- All six files under `assets/` are referenced; 156 relative links and anchors across README, docs and FAQ resolve.
