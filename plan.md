# Implementation plan — whole-app review (T1–T121)

**114 of 121 done · 1 declined · 6 open — 94% complete.**

This file is regenerated from `TODO.md` and this branch's history every time an item merges. It
is not hand-maintained, because a hand-kept plan drifts from the branch it claims to describe.

## How each item is worked

`TODO.md` holds the specification: every item carries its own location, failure scenario, expected
behaviour and acceptance criteria. Items that would touch the same files are worked together as one
cluster, because two agents editing one tree — or two test runs at once — corrupt each other.

Each cluster goes through the same loop:

1. **Implement.** A worker builds the item against the acceptance criteria written in the item.
2. **Review.** Five independent read-only lenses (scope, correctness, tests, acceptance,
   regression) read the diff. Each finding then goes to a separate skeptic instructed to *refute*
   it and to default to refuted when uncertain.
3. **Fix.** One serial fixer applies what survives refutation. Read-only review and a single writer
   is the whole point: parallel writers on one working tree lose each other's edits.
4. **Verify.** The six-step contract, in order, serially:
   `lint` → `typecheck` → `format:check` → `build` → `test:coverage` → `smoke`.
5. **Merge.** Squash onto this branch; the item is ticked in `TODO.md` in the merge commit itself.
6. **Confirm.** CI must be green on the pushed head before the next cluster starts.

Work happens on short-lived `task/<id>` branches that never leave this machine. Only the squash
lands here.

### Standing rules

- **Coverage floors:** branches 74, functions 73, lines 79, statements 79.
- **Package ceilings:** 120 files / 1,640,000 bytes, enforced by `scripts/smoke-test.mjs`. Never
  raised to make a change fit.
- **Mutation discipline.** Every behaviour a change claims to pin is checked by reverting exactly
  that line and confirming a *named* test fails. Each mutant is type-checked first, so that a
  "kill" is never really a compile error, and an inert control mutant must survive — if it dies,
  the harness is broken rather than the code pinned.
- **Every premise is re-verified before it is implemented.** These items were written against
  v5.3.1; most have since landed on this branch, so an item can describe a bug an earlier item
  already fixed. Two clusters lost a round to exactly that.

## Progress

| | count |
|---|---|
| Merged | 114 |
| Declined | 1 |
| Open | 6 |


## Remaining

- **T108** — Reload (r) initializes the new services before injecting the UI logger, so clone/fetch/init output and warn...
- **T109** — Docs/help drift: README and the help modal say Esc quits, but the main screen ignores Esc; README quick sta...
- **T113** — NODE_ENV=test silently disables the cross-process lock, and the e2e double-run test (spawning dist under th...
- **T115** — Repository initialization failures are logged without the repository name in both runOnce and reload paths,...
- **T116** — FileCopyService silently applies a hard-coded ignore list (dist/, build/, .next/, coverage/, …) even to exp...
- **T48** — Docs drift

## Declined

- **T59** — No dry-run/plan surface

## What the review loop caught

These are defects the implementing worker had missed and the full test suite did not catch. They
are the argument for the review step, and for mutation-checking claims rather than trusting a
green suite. The last entry belongs to the cluster still in flight above:

- **T94+T96** — A path-traversal guard that rejected `../` but accepted an absolute path outside the workspace.
- **T100+T101** — Three separate rewirings of `divergence` each passed all 289 MCP tests; one of them broke `get_worktree_status`'s advertised output schema on the wire.
- **T102** — A fail-open: an unreadable `.git` made `detect_context` name a *different* repository and report `createWorktree.available: true`.
- **T105** — `handleUpdateWorktree`'s lazy clone was pinned by nothing — deleting it outright passed all 3,020 tests.
- **T43/T107/T117** — An `isTTY` gate covered by no test: removing it wrote DECSET escape sequences into a pipe. Two cron arms were covered only by a swallowed error.
- **T114** — The README promised a catchable SIGTERM the code did not honour; `cleanup()` reported what it *enumerated*, not what it *signalled*; a `timeoutMs` above 2^31-1 silently became a ~1 ms timeout.
- **T112** — A signal-killed launcher was silently dropped (`code === null`), and `GUI_FORCING_FLAGS` was unscoped, so `emacs -nw -g` still spawned a window.
- **T25+T88+T106** — The central claim was false: `refresh()` bypassed the TTL but not the in-flight map, so the header's disk total could inherit a walk that began before the force clean that prompted it. Reproduced 5/5 on a real 151k-path tree, overstating by 42-46 MB.
- **T41+T45+T46** — The cycle refcount gated only the `setStatus` channel, so `recordSyncOutcome` still reached the UI's idle state through `updateLastSyncTime` and the first cycle to finish wiped the other's progress rows — the item's headline failure, and a regression against the parent. Every new test watched the service's event stream rather than the rendered frame, which is why it passed. Two further finds: a test mock resolved an object where the real function resolves a string, silently unmounting the App mid-test and making every later frame assertion vacuous; and T45's loader guard was pinned by nothing, because every test passed one stable function as the loader while the real caller passes a new arrow on every render.
- **T44** — The fix introduced a regression of its own: making the wizard submit the name it displayed was right, but the service still walked its suffix from the name it was handed, so a second collision produced `x-1-1` instead of `x-2`. Separately, the new rollback was a line-for-line copy of clone mode's — comment included — with exactly the two credential guards deleted, so git's stderr (which embeds the access token for an https remote) reached the wizard's result pane unredacted. A lens also checked the create-only lease against real git 2.43 and found the code's own comment overstated it: git leases only a ref the push would change, so the claim to require the ref's absence was wrong even though the guarantee the fix needs held exactly.

## Follow-ups

166 items found along the way but deliberately left out of scope, recorded separately rather than
widening a cluster's diff. They include a standing security item: `bin/sync-worktrees.js` does not
redact credential-bearing URLs.

## Merge history

101 squash-merged clusters. The 12 most recent:

| commit | item | subject |
|---|---|---|
| `a123c33` | T41 | fix(tui): claim repositories per cycle, end a sync from the cycle count alone, load a modal's list once, and keep the log panel inside its height |
| `8f74f93` | T25 | fix(tui): bound the status fan-out, show what it could not probe, and stop the disk total inheriting a walk that predates the change |
| `37c963c` | T111 | fix(tui): stop the Open wizard reporting success for a launcher that did nothing |
| `e83875d` | T110 | fix(hooks): make the SIGTERM on quit worth sending, and let the timeout be configured |
| `3bcb793` | T42 | fix(tui): Ctrl+C exits cleanly and the terminal is restored on every path |
| `e31a7c0` | T105 | test(mcp): drive the handlers against the real RepositoryContext |
| `7eb5a9f` | T102 | fix(mcp): a nested repository no longer hides the worktree that encloses it |
| `6030578` | T101 | perf(mcp): one status probe per worktree, and one per worktree only once |
| `bcc769b` | T99 | fix(mcp): a found-but-broken config now reaches the agent |
| `31ef870` | T98 | fix(mcp): update_worktree names a detached HEAD instead of denying the path |
| `4595568` | T104 | fix(mcp): create_worktree reports a pre-existing worktree and is idempotent |
| `f555777` | T97 | fix(mcp): derive auto-detected worktreeDir from the registered worktrees |

The full list is `git log claude/app-code-review-optimize-5kr6jf`.
