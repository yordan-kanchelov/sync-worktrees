# Clone mode

Clone mode (`mode: "clone"`) keeps one branch checked out at a fixed path with no bare repository and no per-branch
folders; use it when one checkout is enough — a dependency sibling that expects a fixed relative path, a single-branch
dev clone. The default worktree mode is described in the [README](../README.md#how-it-works).

Set `mode: "clone"` to clone one checked-out branch directly into `worktreeDir` instead of maintaining one worktree per
remote branch:

```javascript
{
  name: "game-platform",
  repoUrl: "ssh://git@example.com/game-platform.git",
  worktreeDir: "./slots/game-platform",
  mode: "clone",
  branch: "main",
  depth: 1,                            // optional shallow clone
}
```

Clone mode keeps only the checked-out branch materialized as a local `origin/*` ref. Branch discovery uses remote
metadata, so the tool can list remote branches without downloading object closure for every branch tip. `branch`
controls the checked-out branch that sync-worktrees fast-forwards on each sync. Omit `branch` and the remote HEAD is
resolved at clone time.

Clone mode rejects `branchInclude`, `branchExclude`, `branchMaxAge`, `updateExistingWorktrees` and `bareRepoDir` at
validation time (whether set directly or inherited via `defaults`) — they have no meaning for a single-branch checkout.
`trash` is rejected too, because clone mode never removes its checkout. `sparseCheckout`, `filesToCopyOnBranchCreate`
and `skipLfs` still apply: `filesToCopyOnBranchCreate` fires exactly once, on the initial clone; `hooks.onBranchCreated`
does not fire on the initial clone (clone mode tracks a single fixed branch with no later branch-creation event, so the
hook stays reserved for the TUI's branch wizard); `sparseCheckout` is re-applied on every sync, so config drift
converges.

## `depth`: a ratcheted cap on every fetch

`depth` is valid only for clone-mode repositories and must be a positive safe integer. It applies to the initial
`git clone --single-branch --no-tags --depth <N>`, and to every routine sync fetch as a **ratcheted cap**:
`--depth max(depth, the window the clone already holds under origin/<branch>)`. The cap is there because a shallow clone
has no ancestors to offer the server as `have`s — once the remote tip stops being a descendant of the clone's tip, which
a force-push or a rebase does, an uncapped fetch has to pack the new tip's whole ancestry. The ratchet is there because
`git fetch --depth N` re-applies N to the ref it fetches rather than capping at it: passed verbatim, the configured
value takes a clone that has just been deepened straight back to one commit, which cuts the parent link needed to tell a
fast-forward from a divergence, so every remote advance would buy another 50-commit deepen that the next tick throws
away. In short: raising `depth` deepens, lowering it does not shorten, removing it unshallows on the next sync.

Both numbers are **ancestry levels**, counted from the ref the fetch re-applies them to. `--depth N` keeps every commit
within N parent steps of the fetched tip, so on a merge-built history one level holds several commits — a 50-level fetch
of a remote whose pull requests land as two-commit merges produced a 147-commit clone. The clone is therefore measured
in levels rather than commits (a count is the larger number, and feeding it back walks the boundary deeper every tick
until the clone is complete and `depth` bounds nothing), and measured from `origin/<branch>` with a local
`git rev-list --topo-order --parents` walk rather than from HEAD — HEAD is the tip a fetch re-applies its depth from
only on a tick that ends in a fast-forward, and on a tick that fetches and then skips the merge (dirty worktree,
unpushed commits, a divergence) it lags behind, so a cap measured there asks for less than the clone holds and cuts it
back, further on every tick. Measured from the fetched ref the cap is a fixed point instead: the window a `--depth D`
fetch produced measures back as exactly D, so history widens only when the deepen budget or a raised `depth` widens it.
(HEAD is the fallback for a first sync, before `origin/<branch>` exists.)

Editing `depth` reaches an existing clone, asymmetrically. Raising it raises the cap, so the next sync fetch deepens a
shorter clone up to the new value — with `depth` raised from 1 to 10, the next fetch took a one-commit clone to 10.
Raising it also **shrinks the deepen budget**, which only uses targets above `depth`: at 1000 or more there is no budget
left, and a clone that cannot be classified can then only be skipped. Lowering `depth` cannot shorten an existing clone
through the sync fetch, which takes the larger of the two. Removing `depth` changes an existing clone wholesale: the
next sync unshallows it with `git fetch --unshallow --no-tags`, which is also the remedy when a sync reports it cannot
classify the tracked branch.

Two other fetches re-apply the configured value verbatim, and `--depth` below the current depth shortens:

- The in-sync deepen budget (below) refetches at `--depth 50`, `200` or `1000` when it cannot classify the tracked
  branch, so a clone grown past the target it picks is cut back to it (80 commits went to 50) — and when the budget
  cannot settle the question either, because a force-push moved the branch off the clone's tip entirely, that repeats
  every tick until the divergence is resolved.
- Switching the clone to another branch from the TUI, and the branch wizard's base-branch fetch, re-apply `depth` to
  whatever ref they name. The shallow boundary is repository-wide, so those can shorten **or** deepen the clone whether
  or not you edited `depth` — including when the ref is the tracked branch itself, which the wizard offers among the
  bases: a clone the deepen budget had grown to 50 commits went back to 1 on a `--depth 1` base fetch of it. The flag
  stays there because dropping it is ruinous for the case it exists for, a branch with a tip of its own the clone has
  never seen: fetching a 290-commit branch (this one built from commits that each rewrite a file) into a `depth: 1`
  clone cost 288 of them — all but the two the clone's existing shallow graft already hid — in an 861-object pack
  without `--depth`, against 1 commit and 3 objects with it.

## Why the cap is ratcheted (measurements)

What the cap costs and buys, all measured on git 2.43. Against a 199-commit remote that force-pushed
(`reset --hard HEAD~3` plus one commit, leaving a 197-commit tip), a `depth: 1` clone fetched 1 commit in a 3-object
pack with the cap and all 197 in a 201-object pack without it — classified `indeterminate_shallow` either way, so the
uncapped download bought nothing. (That remote is empty commits over a three-file seed, so the 201 is 197 commits, the
three trees the clone lacked and the one blob the rewrite added; commits carrying content add a tree and a blob apiece
to it.) Against a 601-commit remote advancing by one merged pull request per tick: one deepen to 50 levels (147
commits), then `--depth 50` and 6 objects per tick, `fast_forward` on the first classification, still 147 commits and
still shallow six ticks later. Against a 120-commit remote advancing three commits a tick with the worktree left dirty
for five ticks, so every tick fetched and skipped the merge: the window held at the 50 levels the deepen bought and the
first clean tick fast-forwarded without deepening again — where the same run measured from HEAD sent `--depth` 50, 47,
41, 32, 20, 5 and had to buy the window back. A clone does not sit at exactly `depth`, though: a remote k levels ahead
pushes the oldest k levels off the bottom, and a tip a force-push moved off the fetched ref's ancestry cannot be held
inside the window by any depth. A clone that is not shallow gets no `--depth` at all, since there the flag would *make*
it shallow — `--depth 5` against a full 199-commit clone left 5 commits.
