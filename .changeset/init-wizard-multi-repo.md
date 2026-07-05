---
"sync-worktrees": minor
---

Rework the `init` wizard: multi-repository setup, mode-aware prompts, and a self-documenting generated config.

- **Multiple repositories in one run.** The wizard now loops with an "Add another repository?" prompt, so a monorepo-sibling setup (the common multi-repo case) can be scaffolded in a single `init` instead of hand-editing the file afterwards.
- **Mode-first prompts.** Each repository asks `worktree` vs `clone` up front, then only the fields that apply to that mode: `bareRepoDir` for worktree mode; optional `branch` and shallow `depth` for clone mode. Clone-mode entries are emitted with `mode: "clone"` and never leak worktree-only fields.
- **Removed the run-once question.** The wizard always generates a scheduled config; `runOnce` stays available as a CLI flag / manual config field for one-shot runs.
- **Self-documenting output.** The generated file appends a commented cheatsheet of the most common advanced options (`branchMaxAge`, `branchInclude`/`branchExclude`, `sparseCheckout`, `updateExistingWorktrees`, clone `branch`/`depth`, `parallelism`, `hooks`, `debug`) with a link to the full reference.
- **CLI discoverability.** `sync-worktrees --init` / `--list` (flag forms of the subcommands) now fail with a hint pointing to `sync-worktrees init` / `list` instead of a bare "unknown argument" error.
