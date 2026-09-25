# Sparse checkout

For monorepos where you need a subset of folders, `sparseCheckout` materializes only the paths you list, and the same
repository can be listed more than once with different patterns. The [README](../README.md#configuration) names the
setting and links here.

Set `sparseCheckout` on a repository entry. The tool runs `git worktree add --no-checkout`, configures sparse-checkout,
then materializes only the included paths. Listing the same `repoUrl` under different `name`s with different patterns
builds domain-grouped layouts:

```javascript
// @ts-check

/** @satisfies {import("sync-worktrees").SyncWorktreesConfig} */
const config = {
  repositories: [
    {
      name: "roulette-game-client",
      repoUrl: "https://github.com/acme/casino-monorepo.git",
      worktreeDir: "/Users/me/game-clients/roulette",
      sparseCheckout: { include: ["game-client"] },
    },
    {
      name: "roulette-autocue",
      repoUrl: "https://github.com/acme/casino-monorepo.git",
      worktreeDir: "/Users/me/autocues/roulette",
      sparseCheckout: { include: ["autocue"] },
    },
  ],
};

export default config;
```

**Modes:**

- `cone` (default): pass folder names in `include`. Fast and recommended.
- `no-cone`: pass gitignore-style patterns including `!negation`. Required for `exclude` and any `!`-prefixed include.

If you set `exclude` or `!`-prefixed patterns while `mode: "cone"` is explicit, the tool auto-promotes to `no-cone` and
logs a warning.

Cone-mode `include` entries are checked at load against the rules `git sparse-checkout set --cone` enforces — no leading
slash, no `*`, `?`, `[` or `]`, and nothing climbing above the repository root with `..` — so `include: ["/apps/web"]`
is a config error naming the repository, the entry and the fix rather than a `worktree add` and rollback per branch on
every tick. Directories are judged in the form git receives them, after the trailing slash, `./`, `..` and
repeated-slash normalization the tool already applies, so `apps/web/` and `./apps/web` are fine. `no-cone` patterns are
left alone: a slash and a glob mean something there.

**Duplicate `repoUrl` handling:** The first entry per `repoUrl` keeps the URL-derived bare path (`.bare/<repo-slug>`).
Subsequent duplicate entries auto-derive `bareRepoDir` from `name` (`.bare/<name>`), so a repository listed twice stores
its history twice. Pin `bareRepoDir` explicitly on duplicate entries if you want config order to be irrelevant.

## Updates that touch nothing in the sparse set

By default a sparse worktree is **not** fast-forwarded when the upstream change touches nothing inside its sparse set:
the working tree would not change either way, so HEAD is deliberately left behind the remote, and `git status` in that
worktree reports it as behind `origin/<branch>` until a change lands inside the set. Set
`sparseCheckout.skipUpdateWhenOutsideSparse: false` to always fast-forward. The check is honoured in cone mode only —
no-cone always proceeds with the update — and if the upstream diff cannot be read the update goes ahead rather than
being treated as "nothing sparse was touched".

## Narrowing safety

When a sync would narrow an existing worktree's sparse patterns (remove a previously included path), it first checks the
worktree is clean. If there are uncommitted changes, unpushed commits, or in-progress operations, the sparse update is
skipped with a warning and reattempted on the next sync. Clone mode applies the same uncommitted-and-untracked-changes
check that gates its fast-forward; unpushed commits are reported there as a skip of their own. The check compares the
new patterns against the ones already in force, so it does not apply to a checkout that is not sparse yet — giving an
existing full checkout a `sparseCheckout` block narrows it on the next sync whether or not the tree is clean, in both
modes. If Git rejects the pattern list outright, the sparse step is recorded as a failed action, so a `--run-once` run
exits non-zero rather than warning and moving on — unless the tree was dirty and the change narrows, in which case the
skip above comes first and the rejection is not discovered until a run finds the tree clean.
