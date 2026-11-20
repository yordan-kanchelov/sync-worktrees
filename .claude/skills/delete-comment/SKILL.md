---
name: delete-comment
description: Remove code comments from this repository. Classifies each comment as tautology, stale, excuse or decision record, deletes it, files an issue for each excuse and moves decision records into docs/adr/, then tightens the comment ratchet. Use when asked to delete or audit comments, or when `local/no-comments` lint errors need clearing. Optional argument - a path or glob to limit the pass (default is the whole repository).
---

# /delete-comment

Comments are banned by the `local/no-comments` ESLint rule (`eslint-rules/no-comments.cjs`). Comments that existed
when the rule landed are grandfathered per file in `eslint-suppressions.json`, the ratchet. A file may never gain
a comment, and when a file loses one, lint fails until the baseline is pruned, so the count only goes down. The
rationale is in `docs/adr/0001-record-decisions-in-adrs-not-comments.md`.

Tool directives are not comments for the rule: `eslint-*`, `@ts-*`, shebangs, `/// <reference>`,
`@vitest-environment`, `prettier-ignore`, `c8|v8|istanbul ignore`, and JSDoc that holds only a type annotation
(`/** @type {...} */`, `/** @satisfies {...} */`). `src/types/public-config.ts` (shipped as the package's `.d.ts`
hover docs) and `sync-worktrees.config.example.js` (user documentation) are exempt.

## Steps

Scope is `$ARGUMENTS` if given (a path or glob), otherwise the whole repository. Work in your scratchpad directory
(`$SCRATCH` below), never in the repository.

1. **List** the comments still present:

   ```bash
   node .claude/skills/delete-comment/scripts/list-comments.mjs $ARGUMENTS --out $SCRATCH/listing.json
   ```

   Each entry is `{ id: "file:line", file, line, endLine, start, end, ownLine, text }`. Consecutive `//` lines are
   one entry.

2. **Classify** every entry. Read the whole file around each comment, and grep before calling anything stale.
   Pick exactly one category. If several fit, the order of precedence is excuse > stale > decision > tautology.
   - **tautology**: says what the code already says. Restated names or types, section banners, JSDoc that
     paraphrases the identifier, test narration (`// Arrange`, `// should return false`), unexplained
     commented-out code.
   - **stale**: refers to code, options, behaviour, review items or history that no longer exist or no longer
     match. This includes "used to" / "previously" narration whose reason no longer constrains the code, and TODOs
     that are already done.
   - **excuse**: justifies an implementation that is worse than it should be: TODO/FIXME/HACK, "for now",
     "temporary", "good enough", logic kept in sync by hand, casts or `any` explained away, errors swallowed with
     "best effort" and no reason, magic sleeps, weakened or skipped tests. A deliberate workaround for a git, OS or
     third-party quirk that cannot be fixed on our side is a decision, not an excuse.
   - **decision**: a non-obvious, still-true decision a reader would need: why this approach over the obvious one,
     an invariant, an ordering constraint, a quirk being handled, a security, concurrency or measured performance
     reason.

   Write one JSON line per entry to `$SCRATCH/classification.jsonl`:
   `{"id", "cat", "why", "unsure", "topic"?, "symbol"?, "decision"?, "title"?, "hack"?}`. Use `unsure: true`
   sparingly. Unsure comments stay in the code for a human to decide, and the ratchet keeps them counted. For a
   large scope, split the listing by file and fan the classification out to subagents, each writing its own
   JSONL file, then concatenate the results.

3. **Decisions → ADRs.** Add each decision to the topic ADR in `docs/adr/` that matches its `topic` (see the
   index in `docs/adr/README.md`), under the heading for its source file. Write it so it reads with the code out
   of view: name the symbol, give the context and the reason, no line numbers and no "here" or "above". If a
   decision is new and substantial, or it reverses an existing entry, start a new numbered ADR instead and
   mark the one it replaces as superseded.

4. **Excuses → issues.** Search the open issues first, using `gh api -X GET search/issues` (or the GitHub MCP
   `list_issues` tool) with the `comment-debt` label. Group excuses that describe the same shortcut into one
   issue. File each new issue with the `comment-debt` label. In the body, list each location as `path:line`
   (from `main`), the hack, what a proper fix looks like, and the original comment text in a quote.

5. **Delete** the classified comments (unsure ones are skipped):

   ```bash
   node .claude/skills/delete-comment/scripts/delete-comments.mjs $SCRATCH/listing.json $SCRATCH/classification.jsonl
   ```

   It deletes whole lines for comments on their own line, strips trailing comments, removes empty JSX
   `{/* */}` wrappers, and refuses any comment whose text moved since the listing.

6. **Tighten the ratchet and verify:**

   ```bash
   pnpm format
   pnpm lint:ratchet
   pnpm lint && pnpm typecheck && pnpm test:unit
   ```

   If `.pnpmfile.cjs` changed, also run `pnpm install --lockfile-only`. pnpm records that file's checksum in
   `pnpm-lock.yaml`, and CI's `--frozen-lockfile` install refuses a mismatch.

   `lint:ratchet` (ESLint `--prune-suppressions`) lowers the per-file counts in `eslint-suppressions.json` to what is left. Never run
   `--suppress-all` or `--suppress-rule` to make lint pass after adding a comment: that loosens the ratchet.

7. **Report** the per-category counts, the lines removed (`git diff --shortstat`), the issues filed, the ADRs
   touched, and how many comments remain (`list-comments.mjs` with no arguments). Add an empty changeset
   (`pnpm changeset --empty`), because the PR check requires one for any code change.
