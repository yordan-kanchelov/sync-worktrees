# ADR-0001: Record decisions in ADRs, not code comments

- **Status:** Accepted
- **Date:** 2026-11-20

## Context

By November 2026 the codebase carried about 4,200 comment blocks, roughly 13,500 lines, in 113,000 lines of
JavaScript and TypeScript. An audit sorted them into four kinds:

- **Tautologies**: restating what the code already says.
- **Stale notes**: describing code, options or history that had since changed.
- **Excuses**: comments that let a shortcut survive review ("best effort", "for now", "kept in sync by hand"), so
  the shortcut got copied elsewhere.
- **Decision records**: real, non-obvious reasons, scattered across hundreds of files where no one could find
  them except by reading the right line.

Comments are not checked by the compiler or the tests, so the first three kinds grow without anything
pushing back. The fourth kind is valuable but sits in the wrong place: a decision that spans a subsystem
should be readable without opening every file it touches.

## Decision

1. **No comments in code.** The `local/no-comments` ESLint rule (`eslint-rules/no-comments.cjs`) reports every
   comment except tool directives:
   - `eslint-*`, `@ts-*`, shebangs and `/// <reference>`;
   - `@vitest-environment`, `prettier-ignore` and `c8|v8|istanbul ignore`;
   - JSDoc that holds only a type annotation, such as `/** @satisfies {...} */`.
2. **Two exemptions.** These are user-facing documentation, not code commentary:
   - `src/types/public-config.ts`: its JSDoc ships in the package's `.d.ts` and appears in users' editors.
   - `sync-worktrees.config.example.js`: the annotated example config.
3. **Decisions live in `docs/adr/`.** There is one ADR per subsystem (see the [index](./README.md)), with entries
   grouped by source file and symbol. A new, substantial or reversing decision gets its own numbered ADR.
4. **Shortcuts become issues.** A known shortcut is tracked as a GitHub issue labelled `comment-debt`, not
   explained away next to the code.
5. **Ratchet, not big bang.** Comments that remain are grandfathered per file in `eslint-suppressions.json` (ESLint
   bulk suppressions):
   - A file may not gain a comment.
   - When a file loses one, `pnpm lint` fails with "suppressions left that do not occur anymore" until the
     baseline is tightened with `--prune-suppressions`.
   - The count only goes down. Loosening the baseline with `--suppress-all` or `--suppress-rule` is not allowed.
6. **Repeatable.** The `/delete-comment` Claude Code skill (`.claude/skills/delete-comment/`) runs the
   classify → delete → ADR → issue → prune loop again on any path.

## Consequences

- Names, types and tests carry the "what". A reviewer who wants a comment asks for a better name, a smaller
  function or a test instead.
- The "why" for a subsystem is in one place. Code review has to check that an ADR still matches the code when
  the code changes. Entries name symbols, not line numbers, so they survive refactors that only move code.
- Content that only made sense right next to the code, such as the exact line a guard protects, is lost.
  The original wording is still in git history: `git log -S '<phrase>'` finds it.
- Lint is slightly stricter: a pull request that adds a comment fails `pnpm lint`.
