# README rewrite — plan and iteration log

The README was a 767-line, ~9,900-word reference manual with a good front door bolted on. The owner asked for a README
a developer can read in a few minutes to understand what the repo is for, that sells the tool better than one bloated
file, with the depth moved to `docs/` where it earns its place. Method: each iteration five critic personas
(first-look, skeptic, agent-user, tech-writer, team-lead) review the current README and write critiques; the PM
dedupes them into pain points, decides Fix / Decline / Defer with a reason, implements, re-verifies every touched fact
against `src/`, and records everything here. The loop stops when no critic has a blocker or major finding left and
every remaining minor or nit is either fixed or declined with a reason below. Positioning follows the site rewrite (PR
#120): human-first Git workspace tool, MCP optional and last.

## Status

Iteration 1 complete; awaiting the iteration 2 review.

| Critic      | Verdict (iteration 1) | Blockers | Majors | Minors | Nits |
| ----------- | --------------------- | -------: | -----: | -----: | ---: |
| first-look  | REQUEST CHANGES       |        2 |      7 |      2 |    1 |
| skeptic     | REQUEST CHANGES       |        1 |      4 |      4 |    3 |
| agent-user  | REQUEST CHANGES       |        0 |      5 |      5 |    1 |
| tech-writer | REQUEST CHANGES       |        2 |      6 |      5 |    1 |
| team-lead   | REQUEST CHANGES       |        2 |      6 |      3 |    1 |

All 61 findings are triaged in the iteration 1 pain-point table below: 26 pain points, 23 fixed, 3 declined, 0
deferred.

## Target structure

### README outline (343 lines after iteration 1)

1. `# sync-worktrees` — site tagline as the quote, four badges (npm version, node, platform, license), one-paragraph
   what-it-is with the safety sentence, the demo GIF, a Contents line listing every H2.
2. `## What you get` — the three commands, then the on-disk tree, then one paragraph on what the folders are.
3. `## Why sync-worktrees` — the four "if you've ever" pains, `cd`/`grep -r`, "why not plain `git worktree`", the
   onboarding angle; `### When not to use it` (three site cases).
4. `## How it works` — worktree mode in two numbered steps, the bare-repo sentence, clone mode in one paragraph with a
   link; `### What it will never do` (five bullets: fast-forward rule, prune gate and the squash-merge exception,
   diverged handling, the stale-directory sweep with the trash-disabled warning, hooks never unattended);
   `### What it costs` (disk with a worked number, network, processes).
5. `## Install and quick start` — install, requirements inline (Node 24+, Git and git-lfs, macOS/Linux, tmux),
   `init` + run, TUI default and `--runOnce` with exit codes and the auth pointer, `--config`;
   `### Running it unattended` (laptop in tmux, build box on a timer, one lock per checkout).
6. `## Configuration` — three sentences, the multi-repo example (no `retry` block, no redundant
   `updateExistingWorktrees`), a topic → page table; `### Team workspace` (portable paths, secrets, the new-hire
   one-liner, what stays manual).
7. `## Interactive TUI` — one paragraph, eight keys, link.
8. `## Optional MCP server` — standard JSON, the Claude Code one-liner with `--scope user`, auto-detect in one sentence,
   the nine tool names, four "cannot do" facts, link.
9. `## CLI reference` — options table (with `-f`), the three subcommands, `### Exit codes`.
10. `## Documentation` — one bullet per docs page plus the example config and the changelog.
11. `## Requirements`, `## Contributing`, `## License`.

### docs map

| Page                              | Owns                                                                                                                                                                                                                                                                                                                                       | Moved from the old README (line ranges of the pre-split file)                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/README.md`                  | Index of the pages below; names the three engineering records so a folder browser is not confused by them                                                                                                                                                                                                                                | new                                                                                                                                                                                                                                                       |
| `docs/configuration.md`           | File formats and discovery; whole-file settings (`runOnce`, `syncOnStart`, `cronSchedule` default); repository entries (`bareRepoDir` default, origin check, directory collisions); branch filtering; authentication; retry, LFS and timeouts; parallelism with the process-budget appendix; maintenance; locking                          | 96, 346–348, 415–419, 421–427 (Authentication), 528–545 (Branch filtering), 683–703 (Retry and LFS), 662–682 (Parallelism), 501–519 (Maintenance), 520–527 (Locking); `runOnce` from `sync-worktrees.config.example.js`                                  |
| `docs/clone-mode.md`              | Clone mode in full; what it rejects and what still applies; `depth` as a rule first, the measurements in a closing appendix                                                                                                                                                                                                              | 428–459 (445 rewritten in present tense, 449 verbatim under "Why the cap is ratcheted (measurements)"); the rejected/still-applies list extended from the example config                                                                                     |
| `docs/sparse-checkout.md`         | Sparse checkout in full plus the `skipUpdateWhenOutsideSparse` rule                                                                                                                                                                                                                                                                       | 460–500; the new section is from `src/types/index.ts` and the example config                                                                                                                                                                              |
| `docs/trash-and-recovery.md`      | "What sync can remove" (every removal path: trigger, gate, destination with trash on/off, undo), diverged branches (default first, `.diverged/` under "When trash is disabled"), trash layout and pin refs, force clean (`x`), the `trash` subcommand with its flag matrix, permanent keep refs, restoring, notes                            | 546–575 (Diverged), 576–661 (Trash and restore), 746–753 (`trash` flags); the removal table is new and sourced from `git.service.ts`, `worktree-mode-sync-runner.ts`, `worktree-status.service.ts`, `worktree-sync.service.ts`                             |
| `docs/hooks-and-file-copying.md`  | Both knobs; "Pattern rules in detail"; "Hook environment and timeout"; "What happens to hooks when you quit"; the agent/sync-created-worktree consequence                                                                                                                                                                                  | 704–729                                                                                                                                                                                                                                                   |
| `docs/tui.md`                     | The TUI paragraph (sync-overlap semantics corrected), full key table and `Esc`/`q`, wizards and status flags, terminal-mode environment variables and per-platform defaults, tmux requirement                                                                                                                                             | 283–343                                                                                                                                                                                                                                                   |
| `docs/mcp.md`                     | Install in every client (site `clients.yaml` order, `--scope user`, no Windows path, PATH note, 6.x upgrade note); "What the server sees" (auto-detect rules and a launched-from table); full tool table plus the `unknown` label and the workspace resource; Safety in full with the removal bullet rewritten; "Parallel agents on parallel branches" | 106–111, 112–129, 131–254, 256–272, 274–282                                                                                                                                                                                                               |

Site coupling: `site/src/pages/llms-full.txt.ts` imports every page above (in the README's Documentation order) and
appends them after the README under `## Docs`; `site/src/pages/llms.txt.ts` lists each page under `## Docs`;
`positioning.yaml` `llmsFullIntro` names the docs pages.

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
| P-24 | SK-10, SK-11, TW-12, TL-12, TL-9, TW-14    | nit      | Diverged example name lacks its suffix; `-f` alias undocumented; `runOnce` never documented as a config key; default schedule not in Quick start; Git/git-lfs unspecified; polish items      | Fix      | Suffix `-lq3k9a2` in `docs/trash-and-recovery.md`; `-f` in CLI reference and trash page; `runOnce` in "Whole-file settings"; "hourly by default" in Quick start; git-lfs in Requirements; `⚠` row re-padded, double blank gone, "bare `sync-worktrees`" gone, "Install in your client" heading |
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
with 37 distinctive phrases, all found).

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

- README length: 343 lines against the tech-writer's 250–280 target. Candidates if the critics still find it long:
  move "Team workspace" to `docs/configuration.md`, fold the Documentation index into the Configuration table, shorten
  "What it costs" to two bullets.
- Confirm with the critics that the "What it will never do" bullets read as the single safety statement the skeptic and
  team-lead asked for, and that the MCP block at ~30 lines is enough of a hook for agent users.

### Follow-ups outside this loop's files

- `site/src/content/faq/05-force-push-delete.md`, `site/src/content/data/features.yaml` (`safety`),
  `site/src/components/BootstrapRepositories.astro`: say force-push survivors go to `.diverged/`; the default is
  `.trash/` (`.diverged/` only with `trash.enabled: false`).
- `site/src/content/data/clients.yaml:26`: Claude Desktop hint gives a Windows path; the package declares
  `os: ["darwin", "linux"]`.
- `site/src/content/data/features.yaml` (`worktree-mode`) and `faq/02-vs-cloning.md`: "disk usage scales with
  working-tree size, not branch count" is wrong for working trees (one full checkout per branch); the README says
  `bare + branches × checkout` instead.
- Behaviour worth the owner's eye, documented as the code does it: the diverged path
  (`worktree-mode-sync-runner.ts:1149,1321–1409`) triggers on any `ahead > 0 && behind > 0`, i.e. also when a teammate
  pushed to a branch you have local commits on, not only after a force-push; a clean worktree in that state is moved
  to `.trash/` (commits pinned) and replaced with a fresh checkout. The old README framed it as force-push only. If
  force-push-only is the intent, that is a code change, not a doc change.
