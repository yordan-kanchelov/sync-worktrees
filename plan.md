# README rewrite — plan and iteration log

The README was a 767-line, ~9,900-word reference manual with a good front door bolted on. The owner asked for a README
a developer can read in a few minutes to understand what the repo is for, that sells the tool better than one bloated
file, with the depth moved to `docs/` where it earns its place. Method: each iteration five critic personas
(first-look, skeptic, agent-user, tech-writer, team-lead) review the current README and write critiques; the PM
dedupes them into pain points, decides Fix / Decline / Defer with a reason, implements, re-verifies every touched fact
against `src/`, and records everything here. The loop stops when no critic has a blocker or major finding left and
every remaining minor or nit is either fixed or declined with a reason below. Positioning follows the site rewrite (PR
#120): human-first Git workspace tool, MCP optional and last.

## Status (Phase 1 — README and docs)

**Converged after iteration 3 (2026-09-18).** Phase 2 (the site) has its own status table under the "Phase 2 — site
alignment" heading at the end of this file.

| Critic      | Final verdict | Blockers | Majors | Minors | Nits |
| ----------- | ------------- | -------: | -----: | -----: | ---: |
| first-look  | APPROVE       |        0 |      0 |      1 |    2 |
| skeptic     | APPROVE       |        0 |      0 |      1 |    2 |
| agent-user  | APPROVE       |        0 |      0 |      4 |    1 |
| tech-writer | APPROVE       |        0 |      0 |      2 |    6 |
| team-lead   | APPROVE       |        0 |      0 |      2 |    1 |

Stop criterion, restated and met: all five critics approve with zero blockers and zero majors, and every minor and nit
from iteration 3 is either fixed (16 of 17 pain points) or declined with a reason (P-76's table-overflow half). The
history: iteration 1 (five REQUEST CHANGES, 61 findings → 26 pain points) restructured the README and split the docs;
iteration 2 (two APPROVE, 47 findings → 35 pain points, no blockers) was precision; iteration 3 (five APPROVE,
26 findings → 17 pain points) was the closing pass.

How to re-verify: every relative link's target must exist and every `#anchor` must match a GitHub-slugged heading in
its target file (131 links and anchors across `README.md` and the seven `docs/` pages); a stock runner such as
`npx markdown-link-check README.md docs/*.md` (or `lychee README.md docs/*.md`) reproduces the check — the loop used a
small node script kept outside the repository. To re-verify a move, `grep -l "<phrase>" README.md docs/*.md` for a
distinctive phrase of the old README (the iteration 1 spot check used 37 of them, all found).

How to re-run this loop: give five reviewers the personas above (a first-time visitor, a skeptic who reads `src/`, an
agent user who sets up the MCP server, a tech-writer who audits structure and moved text, a team lead deciding a
rollout), the quality bar in this file's opening paragraph and the current `README.md` + `docs/`;
each writes findings as `ID | severity | where | problem | evidence | fix`. The PM dedupes them into a pain-point table
(keeping the critic IDs as provenance), verifies every cited fact in `src/` before changing a word, fixes or declines
with a reason, runs the link check, appends an iteration section here, and stops when all five approve with no blocker
or major and nothing minor left undeclared.

## Target structure

### README outline (368 lines after iteration 3)

1. `# sync-worktrees` — site tagline as the quote, five badges (npm version, node, platform, license, release
   workflow), one-paragraph what-it-is with the safety sentence, a Contents line listing every H2.
2. `## What you get` — the three commands, the on-disk tree as `init`'s defaults produce it (`./<repo>/` as
   `worktreeDir`, hash-suffixed branch folders, the default branch plain), one paragraph on what the folders are and
   how they are named, then the demo GIF.
3. `## Why sync-worktrees` — the four "if you've ever" pains, `cd`/`grep -r`, "why not plain `git worktree`", the
   onboarding angle; `### When not to use it` (three site cases).
4. `## How it works` — worktree mode in two numbered steps, the bare-repo sentence, clone mode in one paragraph with a
   link; `### What it will never do` (five bullets, two or three sentences each, exceptions delegated to the trash
   page's table; bullet 5 names clone mode's one-time file copy); `### What it costs` (disk incl. `.trash/`, network,
   processes).
5. `## Install and quick start` — requirements as five bullets (Node, Git/git-lfs, macOS/Linux, tmux, MCP client),
   the install command, one paragraph pointing back at the three commands and forward to Configuration, TUI default
   with the "start a branch with `c`" pointer, `--runOnce` with exit codes and `GIT_TERMINAL_PROMPT`, `--config`;
   `### Running it unattended`.
6. `## Configuration` — three sentences, the multi-repo example, a topic → page table whose page-level rows use the
   canonical page descriptions; `### Team workspace` (five steps: config repo with `.gitignore`, secrets, the
   new-hire one-liner, how to start a branch, what stays manual).
7. `## Interactive TUI` — one paragraph, eight keys (`x` links to force clean), link.
8. `## Optional MCP server` — standard JSON, the Claude Code one-liner with `--scope user`, auto-detect in one
   sentence, the nine tool names, four "cannot do" bullets scoped to trash on/off and `force: true`, link.
9. `## CLI reference` — options table (`--runOnce` links to whole-file settings), the three subcommands with the
   `trash` synopsis fenced, `### Exit codes`.
10. `## Documentation` — one bullet per docs page (canonical descriptions) plus the example config and the changelog.
11. `## Contributing` (how tests and CI run), `## License`.

### docs map

| Page                              | Owns                                                                                                                                                                                                                                                                                                                                                       | Moved from the old README (line ranges of the pre-split file)                                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/README.md`                  | Index of the pages below with the canonical one-line descriptions; names the three engineering records so a folder browser is not confused by them                                                                                                                                                                                                       | new                                                                                                                                                                                                                                                       |
| `docs/configuration.md`           | File formats and discovery; whole-file settings (`runOnce`, `syncOnStart`, `cronSchedule` default); repository entries (`bareRepoDir` default, origin check, directory collisions); branch filtering; authentication; retry, LFS and timeouts (with what the LFS fallback leaves behind and `git lfs pull` as the repair); parallelism with the process-budget appendix; maintenance; locking | 96, 346–348, 415–419, 421–427 (Authentication), 528–545 (Branch filtering), 683–703 (Retry and LFS), 662–682 (Parallelism), 501–519 (Maintenance), 520–527 (Locking); `runOnce` from `sync-worktrees.config.example.js`                                  |
| `docs/clone-mode.md`              | Clone mode in full; what it rejects and what still applies; `depth` as rules (cap, the deepen budget defined right after it, levels, editing with the one-line summary at its end, the two verbatim fetches); every measurement and the HEAD-vs-`origin/<branch>` rationale in the closing appendix                                                     | 428–459 (445 rewritten in present tense; 447 and 449 and the five inline measurements under "Why the cap is ratcheted (measurements)"); the rejected/still-applies list extended from the example config; the deepen budget from `clone-sync.service.ts` |
| `docs/sparse-checkout.md`         | Sparse checkout in full plus the `skipUpdateWhenOutsideSparse` rule and the disk consequence of listing one `repoUrl` twice                                                                                                                                                                                                                             | 460–500; the new section is from `src/types/index.ts` and the example config                                                                                                                                                                              |
| `docs/trash-and-recovery.md`      | "What sync can remove" (every removal path: trigger, gate, destination with trash on/off, undo), diverged branches (default first, the reset-in-place rule stated exactly, "Recovering the commits" through the bare repository with `manifest.json` as the source of `headOid` and the two cases, `.diverged/` under "When trash is disabled"), trash layout and pin refs, force clean (`x`), the `trash` subcommand with its flag matrix, permanent keep refs, restoring, notes | 546–575 (Diverged; the old "cd into the copy and `git diff`" recipe replaced, see iteration 2), 576–661 (Trash and restore), 746–753 (`trash` flags); the removal table is new and sourced from `git.service.ts`, `worktree-mode-sync-runner.ts`, `worktree-status.service.ts`, `worktree-sync.service.ts`, `trash.service.ts` |
| `docs/hooks-and-file-copying.md`  | Both knobs; "Pattern rules in detail"; "Hook environment and timeout"; "What happens to hooks when you quit"; the agent/sync-created-worktree consequence                                                                                                                                                                                                  | 704–729                                                                                                                                                                                                                                                   |
| `docs/tui.md`                     | The TUI paragraph (sync-overlap semantics corrected), full key table and `Esc`/`q`, wizards and status flags, terminal-mode environment variables and per-platform defaults, tmux requirement                                                                                                                                                             | 283–343                                                                                                                                                                                                                                                   |
| `docs/mcp.md`                     | Install in every client (site `clients.yaml` order, `--scope user`, no Windows path, PATH note, 6.x upgrade note); "What the server sees" (auto-detect rules, when `detect_context {path}` loads a config, a launched-from table incl. the workspace root and the clone-mode limits); full tool table (clone-mode limits on `create_worktree`/`update_worktree`), the `unknown` label, the workspace resource and an error-code table that says which other codes pass through; Safety in full with removal scoped to trash on/off and the real collision guard; "Parallel agents on parallel branches" with hashed paths, the exact diverged exception and the lock-dir env note | 106–111, 112–129, 131–254, 256–272, 274–282                                                                                                                                                                                                               |

Site coupling: `site/src/pages/llms-full.txt.ts` imports every page above (in the README's Documentation order) and
appends them after the README under `## Docs`; `site/src/pages/llms.txt.ts` lists each page under `## Docs` with the
canonical description; `positioning.yaml` `llmsFullIntro` names the docs pages.

Canonical page descriptions (used verbatim in README `## Documentation`, the Configuration table's page rows,
`docs/README.md` and `llms.txt.ts`):

- Configuration reference — config formats and discovery, whole-file settings, repository entries, branch filtering,
  authentication, retry and timeouts, parallelism, maintenance, locking.
- Clone mode — one branch at a fixed path; `depth` and the ratcheted fetch cap.
- Sparse checkout — cone and no-cone patterns, one monorepo under several names, updates outside the sparse set.
- Trash and recovery — every removal path, diverged branches, the `.trash/` layout, keep refs, restoring.
- Hooks and file copying — `hooks.onBranchCreated`, `filesToCopyOnBranchCreate`, pattern rules, hook timeout and quit
  semantics.
- Interactive TUI — every key, the wizards, status flags, terminal and editor launch.
- MCP server — install in each client, auto-detect, every tool, safety, parallel agents.

## Iteration 1 — 2026-09-17

### Critic verdicts

| Critic      | Verdict         | Blockers | Majors | Minors | Nits |
| ----------- | --------------- | -------: | -----: | -----: | ---: |
| first-look  | REQUEST CHANGES |        2 |      7 |      2 |    1 |
| skeptic     | REQUEST CHANGES |        1 |      4 |      4 |    3 |
| agent-user  | REQUEST CHANGES |        0 |      5 |      5 |    1 |
| tech-writer | REQUEST CHANGES |        2 |      6 |      5 |    1 |
| team-lead   | REQUEST CHANGES |        2 |      6 |      3 |    1 |

### Pain points

Severity is the highest any raiser assigned. "Where fixed" names the file and section; source citations are the files
re-verified before the wording changed.

| ID   | Raised by                                  | Severity | Pain point                                                                                                                                                                                  | Decision | Where fixed                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-1  | FL-3, TW-1, TW-2, TL-6, SK-5, FL-4         | blocker  | 767 lines / 9,900 words; Configuration subtree is 68% of the words; clone-mode depth, trash and hooks are stand-alone manuals with measurement narratives in the front door                | Fix      | README cut to 343 lines; seven `docs/` pages own the reference material (map above); measurements moved to labelled appendices (`docs/clone-mode.md` "Why the cap is ratcheted (measurements)", `docs/configuration.md` "How the process budget is counted")                                   |
| P-2  | FL-1, FL-2, FL-4, TW-13, SK-3, TL-7, AU-5  | blocker  | First screen never shows the on-disk result or the three commands; no version, OS or license signal; requirements at the bottom and missing the OS and tmux                                | Fix      | README header (badges, one-paragraph pitch), "What you get" (three commands + tree), requirements inline under Install and in `## Requirements`; `package.json` `os`/`engines` re-checked                                                                                                       |
| P-3  | FL-6, FL-9, SK-7, TW-6, TW-7, FL-7         | major    | Leads with AI assistants; MCP is ~180 lines right after Quick start; no "why not `git worktree`"; no "when not to use it"; Features is a two-bullet jargon stub                            | Fix      | Tagline and paragraph from the site positioning; "Why not plain `git worktree`?" and "When not to use it" under Why; Features section removed, its facts folded into Why / Configuration table / TUI; MCP moved after TUI as "Optional MCP server"                                             |
| P-4  | FL-8, TL-2, TL-5, TL-10, SK-9              | blocker  | "background daemon" implied twice but the non-`--runOnce` path always builds the Ink TUI; no unattended story, no sleep behaviour, no exit codes, "only one cycle runs at a time" imprecise | Fix      | "Running it unattended" and "Exit codes" in README; `docs/tui.md` first paragraph and `docs/configuration.md` Locking reworded. Verified `src/index.ts:207–217` (TUI unconditional), `:140–205` (exit code), `:72` (130), `InteractiveUIService.tsx:307` (plain `cron.schedule`, no replay), `App.tsx:193` |
| P-5  | TL-1, AU-8, SK-4, SK-6, FL-7               | blocker  | "Fetches latest changes (no merge — your local work stays untouched)" contradicts the default `--ff-only` update; the prune gate is under-described; safety facts scattered with no one place | Fix      | "What it will never do" in README; `docs/trash-and-recovery.md` "What sync can remove". Verified `config-loader.service.ts:1464`, `worktree-mode-sync-runner.ts:99,115,1137,1150`, `git.service.ts:2104`, `worktree-status.service.ts:178–198,256,315–321`                                     |
| P-6  | SK-1                                       | blocker  | "Unknown top-level directories are never inferred to be owned … left untouched" while an unregistered directory at a managed branch path is swept, and deleted outright with trash off       | Fix      | README safety bullet 4; `docs/trash-and-recovery.md` table row "Stale directory at a managed path" and the paragraph after it. Verified `git.service.ts:1232–1245,1836–1889`, `worktree-sync.service.ts:109–113`                                                                                 |
| P-7  | SK-2, FL-10, TW-5                          | major    | Diverged section leads with `.diverged/` although the default lands in `.trash/`; Features bullet advertises `.diverged/`; site FAQ 05 says the same                                        | Fix      | `docs/trash-and-recovery.md` "Diverged branches" leads with `.trash/`, `.diverged/` under "When trash is disabled"; README bullet 3. Verified `worktree-mode-sync-runner.ts:1478–1561`. Site FAQ 05 / `features.yaml` are outside this loop's files: see follow-ups                          |
| P-8  | FL-2, SK-3, AU-5, TL-7, TW-13              | major    | Windows `%APPDATA%` path in the MCP section while `package.json` declares `os: [darwin, linux]`                                                                                             | Fix      | Windows path dropped; `docs/mcp.md` Claude Desktop block and README Requirements say Windows is not supported. `site/src/content/data/clients.yaml:26` still has the path: follow-up                                                                                                            |
| P-9  | AU-2                                       | major    | `claude mcp add` registers at Claude Code's default local (per-directory) scope, so the server vanishes in the next worktree                                                               | Fix      | `--scope user` in README and `docs/mcp.md` with the reason. Grounded in Claude Code's MCP docs (code.claude.com/docs/en/mcp, read 2026-09-17: "Local scope is the default … loads only in the project where you added it"; user scope is "available across all projects")                       |
| P-10 | AU-3, FL-11, AU-11                         | major    | MCP Safety bullet says an agent cannot delete a worktree, then says removal happens via `sync`, which is agent-callable and `destructiveHint: true`; the push bullet is one 110-word sentence | Fix      | `docs/mcp.md` Safety: first bullet rewritten (only `sync`, same gate, into `.trash/`, flagged destructive); push bullet split in two; README has the four-fact summary. Verified `src/mcp/server.ts:255–270`, `handlers.ts:513–600`                                                             |
| P-11 | AU-4, AU-6                                 | major    | What auto-detect does from `~` or from a worktree whose config is elsewhere is unstated; the one paragraph mixes four rules                                                                 | Fix      | `docs/mcp.md` "What the server sees": four bullets and a launched-from table. Verified `src/mcp/index.ts:16`, `context.ts:302–303,931–961,1396`, `handlers.ts:736–738`                                                                                                                       |
| P-12 | AU-1, AU-7                                 | major    | The parallel-agents workflow is pitched but never shown; per-session state, locking, what `update_worktree` does, and the hooks caveat are absent                                          | Fix      | `docs/mcp.md` "Parallel agents on parallel branches" (seven steps); hooks caveat also in `docs/hooks-and-file-copying.md`. Verified `server.ts:227,320,343`, `handlers.ts:106–130,532,669,688–689`, `utils.ts:98–110`                                                                            |
| P-13 | TL-3                                       | major    | The onboarding promise never shows how a team shares one config: portable paths, secrets, the new-hire command, what stays manual                                                          | Fix      | README "Team workspace". Verified `git-url.ts:216–226`, `logger.service.ts:16`, `index.ts:267` (redaction), example config `:119,129,131`                                                                                                                                                     |
| P-14 | TL-4                                       | major    | Cost per developer (disk, network, processes) never answered                                                                                                                                | Fix      | README "What it costs"; the site's "scales with working-tree size, not branch count" phrasing deliberately not imported. Verified `git.service.ts:841`, `StatusBar.tsx:15`, `index.ts:220`                                                                                                    |
| P-15 | TL-8                                       | major    | `sparseCheckout.skipUpdateWhenOutsideSparse` (default `true`) absent from the README                                                                                                        | Fix      | `docs/sparse-checkout.md` "Updates that touch nothing in the sparse set". Verified `src/types/index.ts:38–48`, runner `:1152–1156`, example config `:265–272`                                                                                                                                   |
| P-16 | FL-5, TW-10, SK-12, TW-4(b)                | major    | Quick start padded with `syncOnStart`, discovery order and `.ts` rules; `syncOnStart` explained three times                                                                                | Fix      | Quick start is the commands plus one sentence each; discovery/`.ts` and `syncOnStart` live once in `docs/configuration.md` ("File formats and discovery", "Whole-file settings")                                                                                                              |
| P-17 | TW-3, SK-4, TL-6, FL-4                     | major    | Contents line lists 6 of 11 H2s and omits Configuration, Trash, Requirements, License                                                                                                       | Fix      | Contents line lists every H2; `## Documentation` index added                                                                                                                                                                                                                                   |
| P-18 | TW-4                                       | major    | Duplicates: minimal config twice, `x` force clean thrice, `trash` flags twice                                                                                                               | Fix      | One owner each: the README tree config is the only minimal example; `x` is defined in `docs/trash-and-recovery.md` (TUI table links); the flag matrix is in the trash page only                                                                                                               |
| P-19 | TW-8                                       | major    | Changelog register in prose: "unchanged from earlier releases", "a `BatchMode` wrapper is a follow-up", past-tense bug narrative in Clone mode                                              | Fix      | Both phrases dropped (see Dropped); the ratchet paragraph rewritten as present-tense behaviour in `docs/clone-mode.md`                                                                                                                                                                         |
| P-20 | TW-9                                       | minor    | Client snippets hand-duplicated from `clients.yaml` and drifting in order                                                                                                                   | Fix      | `docs/mcp.md` blocks in `clients.yaml` order with a source comment; generating them from the yaml is tooling and declined below                                                                                                                                                                 |
| P-21 | SK-8                                       | minor    | 7.0.0 removed `SYNC_WORKTREES_CONFIG` silently; no upgrade note                                                                                                                             | Fix      | `docs/mcp.md` "Upgrading from 6.x". Verified `CHANGELOG.md` 7.0.0 and `grep -r SYNC_WORKTREES_CONFIG src/` (no hits)                                                                                                                                                                          |
| P-22 | AU-10, AU-9                                | minor    | `unknown` status label and the `sync-worktrees://workspace` resource missing; no Node-on-PATH troubleshooting line                                                                          | Fix      | `docs/mcp.md` tool table and the lines after it; PATH note under the standard config. Verified `server.ts:94–105,165`                                                                                                                                                                          |
| P-23 | FL-12, TL-11                               | minor    | Multi-repo example headlines `retry: { maxAttempts: "unlimited" }` and an uncommented `updateExistingWorktrees: true`                                                                       | Fix      | Both removed from the README example; retry lives in `docs/configuration.md` and the example config                                                                                                                                                                                            |
| P-24 | SK-10, SK-11, TW-12, TL-12, TL-9, TW-14    | nit      | Diverged example name lacks its suffix; `-f` alias undocumented; `runOnce` never documented as a config key; default schedule not in Quick start; Git/git-lfs unspecified; polish items      | Fix      | Suffix in `docs/trash-and-recovery.md`; `-f` in CLI reference and trash page; `runOnce` in "Whole-file settings"; "hourly by default" in Quick start; git-lfs in Requirements; `⚠` row re-padded, double blank gone, "bare `sync-worktrees`" gone, "Install in your client" heading (the Git version floor is P-50) |
| P-25 | FL-1 (gif)                                 | blocker  | The demo GIF shows a log panel, never the resulting directories                                                                                                                             | Decline  | See Declined; mitigated by the tree and the three commands in "What you get"                                                                                                                                                                                                                   |
| P-26 | SK-2, TW-5, AU-5, TL-4 (site files)        | major    | Site FAQ 05, `features.yaml` safety, `BootstrapRepositories.astro` say `.diverged/`; `clients.yaml` has the Windows path; `features.yaml` disk claim is wrong for working trees            | Decline  | Outside the files this loop may edit; listed under follow-ups                                                                                                                                                                                                                                  |

### Changes made

- `README.md` — rewritten from 767 to 343 lines around the site positioning (tagline, one-paragraph pitch, badges,
  three commands, on-disk tree, why / why-not / when-not, how it works, "What it will never do", "What it costs",
  install with inline requirements, quick start, "Running it unattended", short configuration with a topic table,
  "Team workspace", TUI keys, optional MCP block, CLI reference with exit codes, documentation index). Demo GIF,
  `// @ts-check` + `@satisfies` examples, MIT/author line kept.
- `docs/README.md`, `docs/configuration.md`, `docs/clone-mode.md`, `docs/sparse-checkout.md`,
  `docs/trash-and-recovery.md`, `docs/hooks-and-file-copying.md`, `docs/tui.md`, `docs/mcp.md` — new; prose moved from
  the README by line range, wrapped at 120 columns with inline code spans kept whole, tables on one line per row. Each
  page opens with one sentence saying what it covers and links back to the README.
- `site/src/pages/llms-full.txt.ts` — imports the seven docs pages (`?raw`), appends them after the README under
  `## Docs`, one `### <title> (canonical, docs/<file>)` each, in the README's Documentation order.
- `site/src/pages/llms.txt.ts` — one `## Docs` line per page with `blob/main` URLs; the README and llms-full lines
  re-described to match.
- `site/src/content/data/positioning.yaml` — `llmsFullIntro` now names "the README's reference pages from docs/".

### Dropped (obsolete or exact duplicate)

- Authentication: "(unchanged from earlier releases)" — release-relative, stale by construction (TW-8).
- Authentication: "; a `core.sshCommand`-aware `BatchMode` wrapper is a follow-up" — roadmap note; the limitation itself
  is kept in present tense (TW-8).
- The second minimal config (old lines 350–367) — byte-identical to the How-it-works config except the repo name
  (TW-4).
- Claude Desktop "Windows: `%APPDATA%\Claude\claude_desktop_config.json`" — the package cannot install there
  (`package.json` `os`) (SK-3, AU-5, TL-7).
- The multi-repo example's `retry` block and its comment, and its `updateExistingWorktrees: true` line — the retry
  defaults table and the per-repo override sentence in `docs/configuration.md` carry the same facts; the example config
  shows the block in place (FL-12, TL-11).
- "`sync-worktrees` always runs against a config file. Create one once, then run the tool." and the CLI intro "The
  CLI loads a config file and runs it. Most run-mode settings … live in the config file." — condensed into the
  `--config` row ("auto-detected in CWD when omitted") and the `--runOnce` row; no fact lost.

Nothing else was removed: every other sentence of the old README is in the README or one of the docs pages (spot-checked
with 37 distinctive phrases, all found). The one sentence the tech-writer later found undeclared ("To manage multiple
repositories, edit the generated config file and add entries under `repositories`") is back in iteration 2 (P-56).

### Declined

- **P-25 / FL-1: re-record the GIF.** The PM cannot produce a recording, and the brief says to keep the demo GIF. The
  "after" picture the critic asked for is now above the fold in text form (the tree directly under the three
  commands), so the GIF is illustrative rather than load-bearing. Owner's call whether to re-record.
- **P-26: fix the site FAQ 05, `features.yaml`, `BootstrapRepositories.astro` and `clients.yaml`.** The brief restricts
  site edits to the two llms pages and `positioning.yaml`. Listed as follow-ups below so they are not lost; the README
  and docs are correct on their own and llms-full.txt will contain both texts until the site copy is fixed.
- **TW-9 (tooling): generate the client blocks from `clients.yaml`.** A build step, not a README change; the blocks now
  follow the yaml's order with a source comment, which removes the drift the critic found.

### Carried to next iteration

- README length (343 lines) and whether the safety bullets read as one statement — answered in iteration 2.

## Iteration 2 — 2026-09-18

Precision fixes only, on top of commit 59b983d; no restructuring. Every touched fact was re-read in `src/` first, and
one was tested against real git (see P-32).

### Critic verdicts

| Critic      | Verdict         | Blockers | Majors | Minors | Nits |
| ----------- | --------------- | -------: | -----: | -----: | ---: |
| first-look  | APPROVE         |        0 |      0 |      4 |    3 |
| skeptic     | REQUEST CHANGES |        0 |      3 |      2 |    3 |
| agent-user  | REQUEST CHANGES |        0 |      4 |      3 |    2 |
| tech-writer | APPROVE         |        0 |      0 |      6 |    5 |
| team-lead   | REQUEST CHANGES |        0 |      3 |      3 |    2 |

### Pain points

| ID   | Raised by                   | Severity | Pain point                                                                                                                                                                                         | Decision | Where fixed                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | --------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P-27 | AU-13, TL-18, FL-16         | major    | Worktree folders are `<stem>-<8 hex of sha256(branch)>` (default branch plain) and `init` defaults `worktreeDir` to `./<repo>`, but the README tree, the MCP recipe and the Safety collision example show plain names and `./worktrees/` | Fix      | README tree redrawn with `init`'s defaults and real suffixes (`feature/login` → `feature-login-df7c7aeb`, `feature-2` → `feature-2-df15e51b`) plus a naming clause; `docs/mcp.md` step 1 (`feat-a-d54ad782`, "take `worktreePath` from the response"); Safety bullet 2 now describes the real guard (target path registered to a different branch); trash-page diagrams use `feature-a-0a5491ed`, `feature-x-c791eb83`. Verified `path-resolution.service.ts:13–24`, `worktree-sync-planner.ts:69–83`, `handlers.ts:546–553`, `git.service.ts:381`, `interactive.ts:64–65`, `trash.service.ts:157,987–991`, CHANGELOG `feature/x` → `feature-x-217d2bf5`; suffixes computed with `node -e` (sha256, first 8 hex) |
| P-28 | SK-13, AU-15                | major    | README MCP paragraph and `docs/mcp.md` Safety say the only removal is a prune into `.trash/`, "never `rm -rf`"; MCP `sync` runs the whole sync (prune, stale sweep, diverged replace) and with trash off prune is a permanent `git worktree remove` and the sweep an `fs.rm` | Fix      | README "Optional MCP server" paragraph; `docs/mcp.md` Safety bullet 1 (same three paths, destinations by trash on/off, link to the table). Verified `handlers.ts:605–618` → `service.sync()`, runner `:104,113,115–117,885`, `git.service.ts:1244,1889`                                                                                                                                             |
| P-29 | SK-14                       | major    | "`updateExistingWorktrees: false` to fetch only" — it gates the update phase only; create and prune still run                                                                                      | Fix      | README bullet 1: "skips the fast-forward phase altogether (worktrees are still created and pruned)". Verified runner `:104–117`, planner `:59–66`                                                                                                                                                                                                                                                 |
| P-30 | SK-15, AU-14                | major    | Line 11, bullet 1 and mcp step 6 say unpushed commits are skipped / never reset, contradicting bullet 3: a clean worktree with unpushed commits whose upstream also moved is diverged (reset or moved) | Fix      | README pitch line ("unpushed commits are never discarded"), bullet 1 ("unless upstream has moved too"), `docs/mcp.md` step 6 rewritten with the diverged exception and a link. Verified runner `:1147–1151` (`local_ahead` only when `behind === 0`), `:1321–1378`                                                                                                                                 |
| P-31 | AU-12                       | major    | Launched-from table row 3 claims the server finds "nothing" from the directory holding the config, where it in fact auto-loads the config and every tool works                                     | Fix      | `docs/mcp.md` table: new row for the workspace root (config auto-loaded, single repo selected, `detect_context`'s `capabilities` describe the probed path, read `configPath`/`configuredRepositories`), row 3 narrowed to "no config above it and no checkout above it". Verified `context.ts:302–314` (config walk-up independent of `.git`), `:562–591` (`configPath: this.configPath` in the unsupported answer), `handlers.ts:56–79,89–91,336–362,744–756`, `context.ts:1041–1048`, `detect_context` response adds `configuredRepositories` (`handlers.ts:245–330`) |
| P-32 | TL-13                       | major    | The only recovery offered for a replaced worktree is `git push --force-with-lease` "from the copy", which erases a teammate's push in the teammate case; nothing says what to do                    | Fix      | README bullet 3 (recover the commits, rebase or cherry-pick, link); trash page Undo cell split into the two cases; new "Recovering the commits" section through the bare repo (`git -C <bare-repo> branch feature-x-recovered <headOid>`, cherry-pick vs `--force-with-lease`); `--restore` refusal noted. Verified `trash.service.ts:485–560` (restore refuses an occupied destination with the diverged-replace hint, and a branch ref that is not at `headOid`), `addWorktreeNoCheckout` writes no sync metadata (`git.service.ts:1811–1815`) so a restored copy is still diverged (`runner:1460–1472`); and tested with git 2.x in the scratchpad: after `worktree remove --force` on the old path, `git status` inside the moved copy fails with "not a git repository" — so the old README's "cd into the copy and `git diff`" recipe never worked and is replaced |
| P-33 | TL-14                       | major    | Nothing says how to start a branch; a branch created locally without a push is pruned on the next tick, and `git checkout -b` inside a managed folder breaks the folder/branch pairing               | Fix      | README Team workspace step 4. Verified `handlers.ts:455–457,506–507,519` (local-only branch pruned; `push` defaults to true), `worktree-status.service.ts:244–247`, `InteractiveUIService.tsx:895–905` (the `c` wizard pushes), planner `:69–73` (the default branch is never planned for creation) and `git.service.ts:398–435` (`ensureMainWorktree` accepts whatever is registered at `main/`) |
| P-34 | TL-15                       | major    | Team workspace tells you to commit the config to a repo without a `.gitignore`, while everything the tool writes lands beside it                                                                    | Fix      | README Team workspace step 1 (`*`, `!.gitignore`, `!sync-worktrees.config.js`; names `.bare/`, the worktree folders with `.trash/`, `.sync-worktrees-state/`, `.sync-worktrees-locks/`). Verified `constants.ts:147–149`, `lock-path.ts:66–69,73–85`, example config `:189`                                                                                                                       |
| P-35 | FL-14                       | minor    | "What it will never do" bullets trail into exceptions                                                                                                                                              | Fix      | Bullets 1, 2 and 4 are two sentences; bullet 3 keeps a third (the TL-13 recovery pointer); the squash-merge, reset-in-place and stash exceptions are named once as living in the linked table                                                                                                                                                                                                      |
| P-36 | FL-13                       | minor    | The GIF pushes the commands and tree below the fold                                                                                                                                                | Fix      | GIF moved to the end of "What you get", after the tree paragraph                                                                                                                                                                                                                                                                                                                                 |
| P-37 | FL-15                       | minor    | Processes bullet is an implementation formula; the listed-twice sentence is a sparse detail                                                                                                        | Fix      | "up to about 40 concurrent git processes by default, tunable"; the listed-twice fact moved to `docs/sparse-checkout.md` (Duplicate `repoUrl` handling), where iteration 3 made the disk consequence explicit (P-73)                                                                                                                                                                              |
| P-38 | TL-16                       | minor    | Disk bullet omits `.trash/` retention and `trash.warnSizeBytes`                                                                                                                                    | Fix      | README "What it costs" Disk bullet. Verified `trash-reaper.service.ts:397–402` (no warning unless set), `constants.ts:92`                                                                                                                                                                                                                                                                         |
| P-39 | TW-18, FL-18                | minor    | Three commands stated twice; requirements stated twice                                                                                                                                             | Fix      | Install opens with requirements as five bullets (the `## Requirements` H2 is gone; badge retargeted to `#install-and-quick-start`), then the install command and one paragraph pointing back at "What you get"; the second `init`/run block removed                                                                                                                                             |
| P-40 | TW-15                       | minor    | Four docs pages state their first sentence twice                                                                                                                                                   | Fix      | `docs/clone-mode.md`, `docs/sparse-checkout.md`, `docs/hooks-and-file-copying.md`, `docs/tui.md` openers deduplicated (the hooks reasoning and the sparse layout sentence kept)                                                                                                                                                                                                                  |
| P-41 | TW-16                       | minor    | Clone-mode rule section still carries five measurements and the HEAD-vs-`origin/<branch>` rationale; the deepen budget is named but never defined                                                | Fix      | "The deepen budget" defined in the rule section (`--depth 50`, `200`, `1000`, only steps above `depth`); the rationale paragraph and the five measurements moved into "Why the cap is ratcheted (measurements)". Verified `clone-sync.service.ts:26` (`SHALLOW_RELATION_DEEPEN_TARGETS = [50, 200, 1000]`), `:102`                                                                             |
| P-42 | TW-17, SK-18                | minor    | Bullet 4 headline contradicts its body; "deleted outright if you disable trash" omits the `.git` quarantine                                                                                        | Fix      | Headline "Touch directories outside the paths it manages"; body names quarantine-if-`.git`, deleted otherwise. Verified `git.service.ts:1880–1889`                                                                                                                                                                                                                                              |
| P-43 | TW-19, SK-20                | minor    | Trash page: "no detour through `.diverged/`" leftover; intro says `.trash/` unconditionally                                                                                                        | Fix      | Diverged paragraph rewritten ("reset in place without moving anything"); intro says "by default"                                                                                                                                                                                                                                                                                                 |
| P-44 | TW-20                       | minor    | Seven pages described in four wordings                                                                                                                                                             | Fix      | One canonical description per page (listed under Target structure) used in README `## Documentation`, the Configuration table's page rows, `docs/README.md` and `llms.txt.ts`                                                                                                                                                                                                                    |
| P-45 | SK-16                       | minor    | Bullet 2's trash-off clause reads as if the squash-merge case is deleted; the code keeps it with a warning                                                                                         | Fix      | The exception left the README bullet (P-35); the table row "Fully pushed, then deleted upstream" carries "Kept with a warning, never removed". Verified runner `:698–702,777–787,822`                                                                                                                                                                                                             |
| P-46 | SK-17                       | minor    | "Nothing committed since the last sync" and the reset's refusal conditions are elided; the table stated one condition twice                                                                        | Fix      | Trash page: HEAD is still the commit the last sync left it at (written at creation, fast-forward and reset; no record counts as local work); a refused reset (ignored files upstream writes, unclean tree incl. submodules, HEAD moved) falls back to the move; Trigger column trimmed. Verified runner `:1353–1378,1460–1472`, `git.service.ts:1195–1196,2110,2206–2216,2254–2291` |
| P-47 | AU-16                       | minor    | `detect_context {path}` loads a config only while none is loaded; the page promised more                                                                                                           | Fix      | `docs/mcp.md` bullet 4. Verified `context.ts:169,257–261,302`                                                                                                                                                                                                                                                                                                                                    |
| P-48 | AU-17                       | minor    | Error codes scattered; `CAPABILITY_UNAVAILABLE` never named                                                                                                                                        | Fix      | `docs/mcp.md` "Error codes" table (six codes plus the pass-through sentence), row 2 names the code. Verified `utils.ts:56–96`, `handlers.ts:70–71`                                                                                                                                                                                                                                             |
| P-49 | AU-18, TW-22                | minor    | README "cannot force-push / cannot create a filtered branch" overstate: pushes are create-only, `force: true` overrides                                                                              | Fix      | README MCP paragraph. Verified `handlers.ts:540–543`, `git.service.ts:2418–2439`                                                                                                                                                                                                                                                                                                                 |
| P-50 | TL-17 (TL-9 carry-over)     | minor    | State a Git version floor                                                                                                                                                                          | Decline  | See Declined                                                                                                                                                                                                                                                                                                                                                                                     |
| P-51 | TL-19                       | nit      | Document node-cron's "missed execution" warning after a laptop wakes                                                                                                                               | Decline  | See Declined                                                                                                                                                                                                                                                                                                                                                                                     |
| P-52 | TL-20, SK-19                | nit      | "Nothing can answer a prompt in either mode" contradicts the config page                                                                                                                           | Fix      | README: "sets `GIT_TERMINAL_PROMPT=0` (unless you exported it yourself)". Verified `git-env.ts:245–246`                                                                                                                                                                                                                                                                                           |
| P-53 | FL-17                       | nit      | No CI badge                                                                                                                                                                                        | Fix      | `release.yml` badge added (it runs on every push to `main`; `pr.yml` runs only on PRs, so its badge would show no status)                                                                                                                                                                                                                                                                        |
| P-54 | FL-19                       | nit      | Contributing is boilerplate                                                                                                                                                                        | Fix      | Names `pnpm install && pnpm test`, `pr.yml`'s checks and the changesets release. Verified `package.json` `scripts`, `.github/workflows/pr.yml:1,54–97`                                                                                                                                                                                                                                            |
| P-55 | TW-21                       | nit      | `x` rows and the `--runOnce` row stop one hop short of their definitions                                                                                                                           | Fix      | Links added in the README key table, `docs/tui.md` and the CLI options table                                                                                                                                                                                                                                                                                                                     |
| P-56 | TW-23                       | nit      | The "add entries under `repositories`" bridge was dropped undeclared                                                                                                                               | Fix      | Restored in Install ("to add repositories, edit that file and add entries under `repositories`")                                                                                                                                                                                                                                                                                                 |
| P-57 | TW-24                       | nit      | Bare "Back to the README." sentences on two pages                                                                                                                                                  | Fix      | `docs/sparse-checkout.md`, `docs/tui.md` back-links folded into sentences                                                                                                                                                                                                                                                                                                                        |
| P-58 | TW-25                       | nit      | Hand-alignment and width leftovers                                                                                                                                                                 | Fix      | `!` row trimmed, `docs/README.md` table re-padded, README line 86 rewrapped, the `trash` synopsis fenced; the two URL lines (badge, Gemini guide) cannot wrap                                                                                                                                                                                                                                     |
| P-59 | AU-19                       | nit      | `SYNC_WORKTREES_LOCK_DIR` must reach the MCP server too                                                                                                                                            | Fix      | `docs/mcp.md` step 5. Verified `repo-operation-lock.ts:186`                                                                                                                                                                                                                                                                                                                                      |
| P-60 | AU-20                       | nit      | Auto-detect's `create_worktree`/`update_worktree` preconditions unnamed                                                                                                                             | Fix      | `docs/mcp.md` bullet 2. Verified `context.ts:729–740`                                                                                                                                                                                                                                                                                                                                            |
| P-61 | TW (plan.md nits)           | nit      | Status table duplicated the verdict table; no re-verify note                                                                                                                                       | Fix      | Status is now a summary; "How to re-verify" note under Status (made tool-independent in iteration 3, P-70)                                                                                                                                                                                                                                                                                       |

### Changes made

- `README.md` (343 → 360 lines): release badge; pitch sentence; GIF after the tree; tree redrawn with `init`'s default
  `worktreeDir` and hash-suffixed folders plus a naming clause; "What it will never do" bullets tightened and corrected
  (fast-forward vs diverged, `updateExistingWorktrees` scope, trash-off consequences, headline of bullet 4, recovery
  pointer); "What it costs" (`.trash/`, processes simplified); Install merged with Requirements and de-duplicated;
  `GIT_TERMINAL_PROMPT` sentence; Configuration table page rows canonical; Team workspace `.gitignore` and
  "start a branch" steps; `x` and `--runOnce` links; MCP paragraph scoped to trash on/off, create-only pushes and
  `force: true`; `trash` synopsis fenced; Documentation index canonical; Contributing concrete; `## Requirements`
  removed.
- `docs/trash-and-recovery.md`: intro "by default"; diverged row (trigger trimmed, gate exact, undo split by case);
  diverged section rewritten (reset rule exact, refused-reset fall-through, "Recovering the commits" via the bare repo,
  `.diverged/` recovery via the keep ref); diagrams with real names; `--restore` refusal note under Restoring.
- `docs/mcp.md`: bullet 2 preconditions; bullet 4 (`detect_context` loads a config only while none is loaded);
  workspace-root row and narrowed last row in the launched-from table; "Error codes" table; Safety bullet 1 scoped to
  trash on/off; collision guard described as coded; step 1 hashed path; step 5 lock-dir env; step 6 diverged exception.
- `docs/clone-mode.md`: duplicated opener removed; the deepen budget defined; measurements and the HEAD-vs-origin
  rationale moved to the appendix.
- `docs/sparse-checkout.md`, `docs/hooks-and-file-copying.md`, `docs/tui.md`: duplicated openers removed; back-links
  folded into sentences; `x` row linked; `!` row re-padded.
- `docs/README.md`, `site/src/pages/llms.txt.ts`: canonical page descriptions.

### Declined

- **P-50 / TL-17: a Git version floor.** The finding's premise does not hold: `src/` contains no call to
  `git worktree repair` (the only hit is a comment at `trash.service.ts:768`; the README's manual restore recipe tells
  the *user* to run it) and none to `git maintenance run` (the maintenance service runs `git gc`,
  `git-maintenance.service.ts:159–161`; "maintenance" otherwise appears only as the config key). Without an
  unconditional call to a version-gated command there is no grounded floor, and "tested against 2.43" is not a claim
  the CI matrix makes. Requirements keep "Git".
- **P-51 / TL-19: node-cron's "missed execution" warning.** `node_modules` is not present in this checkout, so the
  default handler's text and trigger could not be verified here; documenting it would be repeating the critic. Recorded
  as a code-side follow-up (`suppressMissedWarning` or an `execution:missed` listener with a one-line log).

### Carried to next iteration

- README is 360 lines (343 before); all of it was asked for. Trim only if the critics still find it long — they did
  not (iteration 3: "Do not trim").
- Whether the tightened safety bullets and the new recovery section read as one story — they do (iteration 3).

## Iteration 3 — 2026-09-18

Closing pass on top of commit 3c0f902: all five critics approved with zero blockers and zero majors; the remaining
minors and the cheap nits are fixed below, the rest declined with a reason. Every fact was re-read in `src/` before the
wording changed.

### Critic verdicts

| Critic      | Verdict | Blockers | Majors | Minors | Nits |
| ----------- | ------- | -------: | -----: | -----: | ---: |
| first-look  | APPROVE |        0 |      0 |      1 |    2 |
| skeptic     | APPROVE |        0 |      0 |      1 |    2 |
| agent-user  | APPROVE |        0 |      0 |      4 |    1 |
| tech-writer | APPROVE |        0 |      0 |      2 |    6 |
| team-lead   | APPROVE |        0 |      0 |      2 |    1 |

### Pain points

| ID   | Raised by      | Severity | Pain point                                                                                                                                                                      | Decision | Where fixed                                                                                                                                                                                                                                                                                                                                                       |
| ---- | -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-62 | SK-21, TL-21   | minor    | The recovery recipe says "note its headOid" from the `trash` listing, which prints no `headOid` (table columns and `--json` fields alike)                                        | Fix      | `docs/trash-and-recovery.md` recipe: the listing yields the id; `cat <worktreeDir>/.trash/<id>/manifest.json` yields `branch` and `headOid`. Verified `src/index.ts:353–365` (columns), `trash.service.ts:37` (manifest `headOid`)                                                                                                                                 |
| P-63 | AU-21          | minor    | README bullet 5's "never on a tick or from an agent" contradicts the hooks page: clone mode copies `filesToCopyOnBranchCreate` once on the initial clone                          | Fix      | README bullet 5 parenthetical (one-time copy, no hook command runs, link). Verified `clone-sync.service.ts:1988–1996` (`copyFiles` only), no hook call outside `InteractiveUIService.tsx`                                                                                                                                                                       |
| P-64 | AU-22          | minor    | `docs/mcp.md` step 6 says uncommitted edits can reach the diverged path, and names only one reset-in-place case                                                                  | Fix      | Step 6: uncommitted edits are always skipped; only clean + unpushed + upstream moved is diverged; both reset-in-place cases named (content matches, or nothing committed since the last sync — a bare force-push). Verified runner `:1136–1137,1147–1151,1353–1366`                                                                                                 |
| P-65 | AU-23          | minor    | "Anything else is `INTERNAL_ERROR` or `UNKNOWN_ERROR`" — any `SyncWorktreesError` code passes through                                                                            | Fix      | `docs/mcp.md` error-code sentence names `CONFIG_FILE_NOT_FOUND` / `CONFIG_VALIDATION_FAILED` (from `load_config`) and `GIT_*`. Verified `utils.ts:56–62`, `errors/index.ts:18–22,69–88`, `config-loader.service.ts:493,614`                                                                                                                                       |
| P-66 | AU-24          | minor    | `docs/mcp.md` never says clone-mode repositories refuse `create_worktree` / `update_worktree`                                                                                    | Fix      | Tool-table rows prefixed "Worktree mode only (a clone-mode repository answers `CAPABILITY_UNAVAILABLE` — use `sync`)"; launched-from row 1 and the `CAPABILITY_UNAVAILABLE` remedy qualified. Verified `context.ts:165,931–934`, `handlers.ts:56`                                                                                                                 |
| P-67 | TL-23          | minor    | The LFS fallback's consequence is unstated: worktrees full of pointer files, a green run, no later re-download                                                                    | Fix      | `docs/configuration.md` "Retry, LFS and timeouts": pointer files, exit 0 (recorded as `lfs_skip_enabled`, a noop), no later fetch into untouched files, `git lfs pull` or recreate. Verified runner `:582–621` (`recordNoop("repo", "lfs_skip_enabled")`), `git.service.ts:243` (`GIT_LFS_SKIP_SMUDGE=1`), `index.ts:153–205` (noops never fail the run), `clone-sync.service.ts:1800` (the only `git lfs pull`) |
| P-68 | TW-26, FL-21   | minor    | The README's "What an agent cannot do" is one five-line sentence                                                                                                                | Fix      | Four bullets, same facts                                                                                                                                                                                                                                                                                                                                          |
| P-69 | FL-20          | minor    | A solo developer never reaches Team workspace step 4 before running `git checkout -b` in `main/`                                                                                 | Fix      | One sentence after "Press `q` to quit." in Install (start a branch with `c`; don't `git checkout -b` inside a managed folder; link to step 4)                                                                                                                                                                                                                      |
| P-70 | TW-32          | minor    | `plan.md`'s only re-verification tool is a scratchpad script that will not exist after the merge                                                                                 | Fix      | Status now describes the check in words and names a stock runner (`npx markdown-link-check README.md docs/*.md`, or `lychee`); no script added to the repository (docs-only PR)                                                                                                                                                                                  |
| P-71 | SK-22          | nit      | Between `git reset --hard` and the force-push the fresh checkout is diverged again; a tick in the gap moves it a second time                                                     | Fix      | One clause in the force-push case: do both before the next tick. Verified runner `:1136–1151` (classification), `:1353–1366` (HEAD ≠ `lastSyncCommit` after the reset)                                                                                                                                                                                              |
| P-72 | TL-22, SK-23   | nit      | "A branch that exists only locally … is pruned" overstates: a freshly cut branch with nothing of its own is pruned; one carrying commits is kept and warned about               | Fix      | README Team workspace step 4 reworded; the unconditional copy in `docs/mcp.md` Safety bullet 1 removed with P-74. Verified `worktree-status.service.ts:244–247,388`                                                                                                                                                                                                 |
| P-73 | TW-31          | nit      | The sparse page carries the mechanism of duplicate `repoUrl` entries but not the disk consequence P-37 moved out of the README                                                   | Fix      | `docs/sparse-checkout.md`: "so a repository listed twice stores its history twice"                                                                                                                                                                                                                                                                                 |
| P-74 | TW-29, TW-30   | nit      | The `--restore`-refused fact stated three times on the trash page; the local-only-branch fact four times on the MCP page; a bare nav sentence duplicating a link                | Fix      | Trash page: Undo cell points at "Recovering the commits" for the two cases; Restoring's repeat cut to one clause. MCP page: bullet 1's `create_worktree` tail and the bare "Full details…" sentence removed                                                                                                                                                       |
| P-75 | TW-33          | nit      | Clone-mode rule section has two forward references (the deepen budget, the "In short" summary)                                                                                   | Fix      | "The deepen budget" moved to right after the first paragraph; "In short: …" moved to the end of the Editing paragraph                                                                                                                                                                                                                                             |
| P-76 | TW-27, TW-28   | nit      | Rewrap artefact in `docs/tui.md`; hand-aligned rows no longer matching their headers                                                                                              | Fix / Decline | Fixed: `docs/tui.md` paragraph rewrapped; README TUI table widened to its `x` row and the `--runOnce` row padded; `docs/README.md` widened to its Configuration row; `docs/mcp.md` `LOCK_UNAVAILABLE` row padded. Declined: widening the `docs/tui.md` key table (the `x` link) and env-var table, and the `docs/mcp.md` tools table, to their longest cells — see Declined |
| P-77 | AU-25          | nit      | Launched-from row 4 promises `detect_context {path: "<any worktree>"}` loads a config; only a worktree under the config's tree does                                              | Fix      | Row 4 cell: a worktree under the directory holding the config, or `load_config {configPath}` (required when the worktree lives outside the config's tree). Verified `context.ts:302–314,676–715,958–961`                                                                                                                                                          |
| P-78 | FL-22          | nit      | Caption puts a parenthetical between the clause and its colon                                                                                                                    | Fix      | "With one repository declared and `init`'s default `worktreeDir` (`./<repo>`), the directory holding the config becomes:"                                                                                                                                                                                                                                         |

### Changes made

- `README.md` (360 → 368 lines): caption reworded; bullet 5 names clone mode's one-time file copy; "To start a
  branch…" sentence after `q`; Team workspace step 4 distinguishes a freshly cut branch from one with commits; TUI table
  widened; MCP "cannot do" paragraph as four bullets; `--runOnce` row padded.
- `docs/trash-and-recovery.md`: recipe reads `headOid` from `manifest.json`; the force-push case says to reset and push
  before the next tick; the Undo cell and the Restoring paragraph defer to "Recovering the commits" instead of
  repeating it.
- `docs/mcp.md`: clone-mode limits on `create_worktree` / `update_worktree` in the tool table, launched-from row 1 and
  the `CAPABILITY_UNAVAILABLE` remedy; row 4's `detect_context` cell narrowed; the error-code pass-through sentence;
  step 6's exact diverged rule; Safety bullet 1's tail and the bare nav sentence removed; `LOCK_UNAVAILABLE` row padded.
- `docs/configuration.md`: what the LFS fallback leaves behind and how to repair it.
- `docs/sparse-checkout.md`: the disk consequence of listing one `repoUrl` twice.
- `docs/clone-mode.md`: the deepen budget defined before it is first named; the one-line summary at the end of the
  Editing paragraph.
- `docs/tui.md`: paragraph rewrapped. `docs/README.md`: table re-padded.
- `plan.md`: this section; Status set to converged with the final verdict table, the stop criterion, a tool-independent
  re-verify note and "How to re-run this loop"; Target structure refreshed; follow-ups extended.

### Declined

- **P-76 (half) / TW-28: widen every overflowing table column to its longest cell.** The `docs/tui.md` key table
  (one linked cell), its env-var table (a pre-existing 300-character cell) and the `docs/mcp.md` tools table (cells of
  200+ characters) would need 105–220-column rows of padding, which makes the source harder to read than the overflow
  does; GitHub and npm render both forms identically. The rows that were merely short of their header are padded.

### Carried to next iteration

- None: the loop is converged (see Status).

### Follow-ups outside this loop's files

- `site/src/components/Hero.astro` (the animated `worktrees/` tree and the `✓ frontend/feature-login` lines) and
  `BootstrapRepositories.astro` ("Jump straight to `./worktrees/frontend/feature-login`") show plain branch folder
  names; on disk every non-default branch folder carries the `-<8 hex>` suffix (`feature-login-df7c7aeb`).
- `site/src/content/faq/05-force-push-delete.md`, `site/src/content/data/features.yaml` (`safety`),
  `site/src/components/BootstrapRepositories.astro`: say force-push survivors go to `.diverged/`; the default is
  `.trash/` (`.diverged/` only with `trash.enabled: false`). FAQ 05 also describes only the force-push trigger.
- `site/src/content/data/clients.yaml:26`: Claude Desktop hint gives a Windows path; the package declares
  `os: ["darwin", "linux"]`.
- `site/src/content/data/features.yaml` (`worktree-mode`) and `faq/02-vs-cloning.md`: "disk usage scales with
  working-tree size, not branch count" is wrong for working trees (one full checkout per branch); the README says
  `bare + branches × checkout` instead.
- Code, for the owner: (a) the diverged path (`worktree-mode-sync-runner.ts:1149,1321–1409`) triggers on any
  `ahead > 0 && behind > 0`, not only after a force-push — documented as such; if force-push-only is the intent, that is
  a code change. (b) `cron.schedule` at `InteractiveUIService.tsx:307` passes no `suppressMissedWarning` /
  `execution:missed` handling, so node-cron's default warning after a laptop wakes is likely (unverified here).
  (c) `init` could offer to write the `.gitignore` the README now recommends. (d) The old README's `.diverged/` review
  recipe (`cd` into the copy, `git diff`) cannot work because the copy's `.git` link points at a removed registration;
  the runner's own log line at `worktree-mode-sync-runner.ts:1381–1384` still prints that advice, while the log line
  "recover with: git branch <name> <keepRef>" is the right one and the docs now follow it. (e) `sync-worktrees trash
  --json` (and the table) could carry `headOid` and `pinRef`, which the recovery recipe currently reads from
  `manifest.json`. (f) The LFS fallback is recorded as a noop (`lfs_skip_enabled`), so a run that left pointer files
  behind exits 0; a CI owner may want it surfaced as a skip or a warning in the summary line.

## Phase 2 — site alignment

The owner wants the marketing site under `site/` to agree with the README, the docs and the source ("until we update
the site as well so we don't see disagreements"). Same loop, five personas (consistency-auditor, skeptic, first-look,
agent-user, team-lead), same truth order (`src/`, then README/docs, then the site), the file scope and verification
steps from the Phase 2 addendum: `cd site && npm run build` must pass, the rendered `dist/index.html` and
`dist/llms-full.txt` are grepped for every fixed fact, the regenerated `site/public/og-image.png` is restored unless
the OG text changed, and the README/docs link checker still runs.

### Status (Phase 2)

Site iteration S1 complete; awaiting the S2 review.

| Critic               | Verdict (S1)    | Blockers | Majors | Minors | Nits |
| -------------------- | --------------- | -------: | -----: | -----: | ---: |
| consistency-auditor  | REQUEST CHANGES |        4 |      5 |      7 |    5 |
| skeptic              | REQUEST CHANGES |        4 |      4 |      3 |    1 |
| first-look           | REQUEST CHANGES |        2 |      2 |      4 |    2 |
| agent-user           | REQUEST CHANGES |        1 |      5 |      4 |    0 |
| team-lead            | REQUEST CHANGES |        3 |      5 |      2 |    0 |

### Site iteration S1 — 2026-09-18

On top of commit 3a0a793. 63 findings → 32 pain points: 30 fixed, 2 declined. Every fact was re-read in `src/`
before the site copy changed; folder names were computed by reproducing `sanitizeBranchName` in `node -e`.

#### Decisions

- **Folder names.** Real names, shown once each with a one-line caption: `feature/login` → `feature-login-df7c7aeb`
  and, for the second example branch, the dot-free `release/next` → `release-next-36d47e0c` (the old `release-2.4`
  would render as `release-2_4-a7bed77b`, because `sanitizeBranchName` rewrites every character outside
  `[a-zA-Z0-9_-]` to `_`; teaching that rule in a hero is not worth the confusion, so the rule went into the README's
  naming clause instead). The default branch stays `main`. The problem/solution bullet now uses the same suffix in
  both repos on purpose — the hash is of the branch name, so the same branch gets the same folder everywhere, which
  is the "stable paths" claim demonstrated rather than undermined.
- **Hero transcript.** Real log lines under `$ sync-worktrees --runOnce`, because the plain command opens the TUI:
  `🔄 Syncing 2 repositories...` (`src/index.ts:73`), `[frontend] ✅ Clone successful.` (`git.service.ts:356`, with
  the logger's `[repo] ` prefix, `logger.service.ts:32-34`), `[frontend] Step 2: Creating 1 new worktrees...`
  (`worktree-mode-sync-runner.ts:506`), `[frontend]   ✅ Created worktree for 'feature/login'` (`:556`), then the
  tree. The invented `✓ cloned frontend`, `✓ frontend/main` and `workspace ready` lines are gone; the transcript ends
  on the tree instead of a fabricated summary line (the real summary reads `📊 Processed 2 repos: 2 synced, 0 with
  clone-mode skips, 0 failed`, `src/index.ts:196-201`, which is true but unhelpful in a hero).
- **"One config" showcase.** Now the smallest config the loader accepts — `name`, an scp-style `repoUrl`
  (`git@github.com:acme/frontend.git`, `git-url.ts:50`) and `worktreeDir: "./worktrees/<repo>"` per entry, with
  the `@satisfies` annotation and `export default` — so the `worktrees/` root the tree draws is what that config
  produces. Caption: "Declare your repos once. Commit the file to a small workspace repo of its own …".
- **Section order.** `WhenNotToUse` moved above `AgentIntegration` in `index.astro`: the README puts "When not to
  use it" in Why and MCP last; the MCP band's heading size is unchanged (it is the page's one dark section).
- **Demo GIF.** Not embedded (declined, see below). **OG image.** Untouched: it echoes the headline, the subhead's
  first sentence and "One config rebuilds the workspace", none of which changed; the regenerated PNG was restored
  with `git checkout`.

#### Pain points

| ID   | Raised by                          | Severity | Pain point                                                                                                                                  | Decision | Where fixed                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S-1  | CA-1, SK-4, FL-1, TL-6             | blocker  | Plain branch folder names in seven places; on disk every non-default folder is `<stem>-<8 hex>`                                             | Fix      | `Hero.astro` transcript and tree (+ caption line), `BootstrapRepositories.astro` "Stable paths" card, `problem-solution.yaml` with-4, `AgentIntegration.astro` example heading. README naming clause extended with the `_` rule and the 80-character stem cap (`path-resolution.service.ts:9-20`). Suffixes from `node -e` reproducing the function                    |
| S-2  | CA-2, SK-3, FL-3, AU-10, TL-1      | blocker  | `.diverged/` named as the default destination; the page never says `.trash/`                                                                | Fix      | `features.yaml` safety card, `BootstrapRepositories.astro` centred line, FAQ 05 (`.diverged/` only when trash is disabled). Verified `worktree-mode-sync-runner.ts:1483-1514`, `constants.ts:90-92`                                                                                                                                                                       |
| S-3  | CA-3, SK-2, AU-1                   | blocker  | `%APPDATA%` Windows path in the Claude Desktop hint                                                                                          | Fix      | `clients.yaml` Claude Desktop hint (macOS path, "Windows is not supported: the package declares os: darwin, linux"). Verified `package.json` `os`                                                                                                                                                                                                                       |
| S-4  | CA-4, SK-6, FL-2, TL-2             | blocker  | "Disk usage scales with working-tree size, not branch count" on the card and in FAQ 02                                                       | Fix      | `features.yaml` worktree-mode card, FAQ 02 (history once; each branch a full checkout; 200 × 300 MB = 60 GB; the filters). Verified `worktree-sync-planner.ts:83` (one worktree per planned branch), README "What it costs"                                                                                                                                              |
| S-5  | SK-1, CA-9, FL-6, TL-7             | blocker  | The "One config" showcase does not load (no URL scheme, no `worktreeDir`) and its caption promises branches                                 | Fix      | `Hero.astro` showcase and caption (see Decisions). Verified `git-url.ts:46-55`, `config-loader.service.ts:588-598`                                                                                                                                                                                                                                                       |
| S-6  | SK-5, FL-7, CA U-3                 | major    | The animated transcript shows lines the tool never prints, under a command that opens the TUI                                                | Fix      | `Hero.astro` (see Decisions)                                                                                                                                                                                                                                                                                                                                             |
| S-7  | CA-5, SK-7, FL-4, TL-3             | major    | heroDiskNote "left alone"; unpushed commits described as always refused; FAQ 07 "never merge or rebase" without the diverged exception      | Fix      | `positioning.yaml` heroDiskNote (README's words), `features.yaml` safety card, FAQ 05, FAQ 07. Verified runner `:1136-1151,1352-1413`                                                                                                                                                                                                                                    |
| S-8  | CA-6, SK-8, FL-8, AU-2             | major    | `claude mcp add` without `--scope user`; the hint never says why                                                                            | Fix      | `commands.yaml` claudeMcpAdd (propagates to the tab, `llms.txt`, `llms-full.txt`), `clients.yaml` Claude Code hint. Grounded in Claude Code's MCP docs (Phase 1 P-9). Code note: `src/utils/mcp-registration.ts:53` (init's own registration) also omits the scope — follow-up                                                                                          |
| S-9  | CA-7, SK-9, FL-9, AU-3, AU-6       | major    | Four tools in FAQ 03, six on the card, nine in the README                                                                                   | Fix      | `mcp-tools.yaml` lists all nine with a source comment; FAQ 03 names all nine. Verified nine `registerTool` calls in `src/mcp/server.ts`                                                                                                                                                                                                                                  |
| S-10 | CA-8, FL-3, FL-5                   | major    | The site never says removals are reversible                                                                                                 | Fix      | `.trash/`, 30 days and `sync-worktrees trash --restore` in the Bootstrap line, the safety card, FAQ 05 and FAQ 07                                                                                                                                                                                                                                                       |
| S-11 | AU-4                               | major    | `create_worktree` blurb reads as if the push is opt-in; omits create-only and worktree-mode-only                                            | Fix      | `mcp-tools.yaml` create_worktree (and update_worktree "worktree mode only"). Verified `handlers.ts:519`, `git.service.ts:2418,2439`, `context.ts:931-934`                                                                                                                                                                                                                |
| S-12 | AU-5, CA-14                        | major    | No "what an agent cannot do", no link to docs/mcp.md; the prerequisite pill overpromises                                                     | Fix      | `AgentIntegration.astro`: four condensed bullets, `sync` flagged destructive, link to `docs/mcp.md`; pill reworded (worktree tools from any managed worktree; `sync`/`initialize` need the config or `load_config`). FAQ 03 links the docs page too                                                                                                                      |
| S-13 | CA-5, SK-11, TL-4                  | major    | FAQ 05 says force-push-only and "uncommitted work"; the gate list is short; "removed" with no destination                                    | Fix      | FAQ 05 rewritten (diverged trigger incl. a teammate's push; dirty trees never reach it; stash skip; six-condition gate; `.trash/` 30 days; TUI status view)                                                                                                                                                                                                              |
| S-14 | TL-5, SK-12, FL-5                  | major    | FAQ 07: the diverged exception missing, "pushed with `--no-track`" names the wrong mechanism, the swept-directory caveat absent              | Fix      | FAQ 07 rewritten (dirty skipped by every phase; diverged replace; six-condition gate; `.trash/`; swept directory in one sentence; `--no-track` at creation, create-only push). Verified `git.service.ts:2418,2439,1232-1245,1836-1889`                                                                                                                                     |
| S-15 | TL-8                               | major    | FAQ 04 omits the per-entry bare repo, LFS per checkout and the sparse-set update rule                                                        | Fix      | FAQ 04 rewritten; the unverified "multi-million-line" dropped (see Dropped)                                                                                                                                                                                                                                                                                              |
| S-16 | CA-10, AU-8                        | minor    | `list_worktrees` label set omits `unknown` and the grouped-across-repos behaviour                                                            | Fix      | `mcp-tools.yaml` list_worktrees. Verified `server.ts:165`                                                                                                                                                                                                                                                                                                                |
| S-17 | CA-11, SK-10                       | minor    | Removal gate lists four of six conditions                                                                                                   | Fix      | Safety card, FAQ 05, FAQ 07 name modified submodules and detached HEAD. Verified `worktree-status.service.ts:306-321`                                                                                                                                                                                                                                                    |
| S-18 | CA-12                              | minor    | "Every remote branch" without the filter qualifier (card, meta description, llms.txt)                                                       | Fix      | `features.yaml` worktree-mode, `positioning.yaml` metaDescription, `llms.txt.ts`; the hero headline stays as the README's own tagline                                                                                                                                                                                                                                   |
| S-19 | CA-13                              | minor    | "Clean branches fast-forward themselves"                                                                                                    | Fix      | `problem-solution.yaml` with-1: "Clean, fully pushed branches …"                                                                                                                                                                                                                                                                                                         |
| S-20 | CA-15, TL-9                        | minor    | FAQ 06 never says there is no headless daemon; QuickStart step 3 wording                                                                     | Fix      | FAQ 06 rewritten (TUI in tmux, `--runOnce` on a timer, lock-held skip exits 0); `QuickStart.astro` step 3 body                                                                                                                                                                                                                                                          |
| S-21 | CA-16                              | minor    | Requirements on the page omit Git and tmux                                                                                                  | Fix      | `QuickStart.astro` step 1 body                                                                                                                                                                                                                                                                                                                                          |
| S-22 | CA (ordering)                      | minor    | The MCP band sits above "When not to use it", against the README's emphasis                                                                 | Fix      | `index.astro` order: Quick start → When not to use → MCP → FAQ                                                                                                                                                                                                                                                                                                          |
| S-23 | AU-7                               | minor    | `detect_context` last on the card and without its cross-repo map                                                                            | Fix      | `mcp-tools.yaml` order 1 with the docs wording (`includeAllWorktrees`, capabilities block)                                                                                                                                                                                                                                                                              |
| S-24 | AU-9                               | minor    | Cursor hint treats global and per-project files as equivalent; Codex hint starts with a dangling "Or"                                        | Fix      | `clients.yaml` Cursor and Codex hints                                                                                                                                                                                                                                                                                                                                    |
| S-25 | TL-10                              | minor    | "Commit the file" without saying where, or about the `.gitignore`                                                                           | Fix      | Hero caption ("a small workspace repo of its own"), Bootstrap "Same layout" card (three-line `.gitignore`, "see the README's Team workspace section"). A hyperlink inside that card is not possible through `inlineCodeToHtml`, so it is a text reference; the docs link lives in the MCP section and FAQ 03                                                              |
| S-26 | CA-17, AU-8                        | nit      | "sync — fetch, create, prune" drops "update"                                                                                                | Fix      | `AgentIntegration.astro` step 4                                                                                                                                                                                                                                                                                                                                          |
| S-27 | CA-18                              | nit      | `llms.txt` "ships an MCP server" (not optional), "monorepo sibling dependencies"                                                            | Fix      | `llms.txt.ts` intro paragraph; `llms-full.txt.ts` "AI agents" intro says optional too                                                                                                                                                                                                                                                                                    |
| S-28 | CA-19                              | nit      | llmsFullIntro does not describe what the file contains                                                                                      | Fix      | `positioning.yaml` llmsFullIntro                                                                                                                                                                                                                                                                                                                                         |
| S-29 | CA-20                              | nit      | Bootstrap config's `branchExclude: ["wip-*", "tmp-*"]` can never match after the include                                                     | Fix      | `branchExclude: ["feature/wip-*"]`. Verified `branch-filter.ts` (anchored patterns, include first)                                                                                                                                                                                                                                                                       |
| S-30 | CA-21                              | nit      | ctaHeadline "checked out and current" over-promises for branches with local commits                                                          | Fix      | "Every branch, checked out and kept in sync."                                                                                                                                                                                                                                                                                                                            |
| S-31 | FL-10                              | nit      | The demo GIF is copied into `dist/` but referenced nowhere                                                                                  | Decline  | See Declined                                                                                                                                                                                                                                                                                                                                                             |
| S-32 | CA (ordering, heading size)        | nit      | Drop the MCP heading a size                                                                                                                 | Decline  | See Declined                                                                                                                                                                                                                                                                                                                                                             |

#### Changes made

- `site/src/components/Hero.astro`: loadable showcase config; real `--runOnce` transcript; tree with real folder
  names and a naming caption; "Declare your repos once … a small workspace repo of its own".
- `site/src/components/BootstrapRepositories.astro`: `.trash/` safety line (per-entry `.bare/`, 30 days, restore,
  never touched / never discarded); "Stable paths" and "Same layout" cards; `branchExclude` fixed; card bodies now
  render inline code through `inlineCodeToHtml`.
- `site/src/components/QuickStart.astro`: step 1 names Git and tmux; step 3 says TUI now-then-hourly, `--runOnce`
  for CI or a timer.
- `site/src/components/AgentIntegration.astro`: pill reworded; example path `backend/release-next-36d47e0c`;
  "sync — fetch, create, prune, update"; "What an agent cannot do through it" (four bullets) and a `docs/mcp.md`
  link.
- `site/src/pages/index.astro`: `WhenNotToUse` before `AgentIntegration`.
- `site/src/content/data/positioning.yaml`: heroDiskNote, metaDescription, ctaHeadline, llmsFullIntro.
- `site/src/content/data/features.yaml`: worktree-mode and safety cards.
- `site/src/content/data/problem-solution.yaml`: with-1 and with-4.
- `site/src/content/data/mcp-tools.yaml`: nine tools, `detect_context` first, push semantics, `unknown` label,
  worktree-mode-only notes, a source comment.
- `site/src/content/data/clients.yaml`: Claude Code, Cursor, Claude Desktop, Codex hints.
- `site/src/content/data/commands.yaml`: `claudeMcpAdd` with `--scope user`.
- `site/src/content/faq/02-vs-cloning.md`, `03-mcp-agents.md`, `04-monorepos.md`, `05-force-push-delete.md`,
  `06-cron.md`, `07-uncommitted-safety.md`: rewritten as listed above (FAQ 01 unchanged).
- `site/src/pages/llms.txt.ts`, `site/src/pages/llms-full.txt.ts`: "every selected branch", "optional MCP server",
  "dependency siblings".
- `README.md`: the naming clause under "What you get" now states the `_` rewrite and the 80-character stem cap.

#### Dropped

- Hero transcript lines `✓ cloned frontend`, `✓ frontend/main`, `✓ backend/release-2.4`, `workspace ready`: the tool
  never prints them (grep of `src/`).
- FAQ 04 "multi-million-line monorepos": an unverified number (CA U-2); the mechanism stays.
- FAQ 05 "uncommitted work is never silently lost" as the diverged-case promise: dirty worktrees never reach that
  path (`runner:1136-1137`); FAQ 07 now carries the uncommitted-work promise where it is true.

#### Declined

- **S-31 / FL-10: embed the README's demo GIF.** It shows a log panel scrolling clone progress (Phase 1, FL-1), not
  the folders; the hero already carries real log lines and the real tree, and a 517 KB animation under it would
  push the config showcase down for no new information. Copying it into `dist/` is `prebuild` in
  `site/package.json`, which is outside this phase's files; left as is.
- **S-32: drop the MCP heading a size.** Placement was the disagreement with the README's emphasis and is fixed by
  the reorder; the band is the page's only dark section and its heading size is a design choice, not a claim.

#### Carried to next iteration

- Whether the real `--runOnce` transcript still reads as a demo to the first-look critic, and whether the naming
  caption under the tree is enough for the "stable paths" claim.
- The four Phase 1 follow-ups about the site (Hero names, `.diverged/` in FAQ 05 / `features.yaml` / Bootstrap,
  the `clients.yaml` Windows path, the `features.yaml` / FAQ 02 disk claim) are addressed by S1; the Phase 1 list is
  left as written, and the list below is the live one.

#### Follow-ups (code, for the owner)

- `src/utils/mcp-registration.ts:53`: `init`'s own `claude mcp add sync-worktrees -- npx …` omits `--scope user`,
  so the wizard registers the server for one directory while the README, docs and site now say `--scope user`.
- The Phase 1 code items (a)–(f) above still stand.
