# ADR-0016: Build and tooling

- **Status:** Accepted
- **Date:** 2026-11-20
- **Source:** 41 code comments as of `5f17242`, moved here by [ADR-0001](./0001-record-decisions-in-adrs-not-comments.md)

## Context

The package is bundled with esbuild, type-checked with the native TypeScript 7 compiler, linted with typescript-eslint on TypeScript 6, and published with changesets.

## Decisions

Grouped by the file that implements them, source before tests. Each entry names the symbol it governs.

### `.pnpmfile.cjs`

- **.pnpmfile.cjs readPackage**: The project compiles with TypeScript 7 (native Go compiler) which has no JS compiler API, while typescript-eslint's type-aware rules need TypeScript <= 6 as a peer. pnpm overrides and packageExtensions cannot redirect a peer, so a readPackage hook turns the peer into a private TypeScript 6 dependency of the linter packages; pnpm checksums the hook file in the lockfile so frozen installs stay reproducible.

### `demo/launch/render.mjs`

- **demo/launch/render.mjs**: The launch-video renderer is run by demo/launch/render.sh from a scratch directory holding index.html, fonts and demo frames. `node render.mjs frames [fps] [seconds]` writes frames/00000.png onward; `node render.mjs stills <t>...` writes stills for checking layouts. Chromium comes from CHROME_PATH if set, otherwise Playwright's own download.

### `esbuild.config.js`

- **esbuild.config.js buildOptions**: The CLI and MCP server are built in one esbuild run with splitting so modules they share are emitted once into dist/chunk-*.js rather than bundled into each entry. The entries keep their names so the bin shims load dist/index.js and dist/mcp-server.js.
- **esbuild.config.js buildOptions**: Bundles are not minified so stack traces and redacted error output pasted into issues stay readable; the shared chunk already removed most size duplication. No source maps are emitted because Node only applies them with --enable-source-maps, src/ is not published, and they would add 0.5-1.5 MB; the tarball size ceiling lives only in scripts/smoke-test.mjs so the two cannot drift.
- **esbuild.config.js**: The build deletes dist/ first because chunk names are content hashes; without the wipe a rebuild leaves the previous build's chunks behind and npm pack ships them.

### `eslint.config.cjs`

- **eslint.config.cjs**: @typescript-eslint/require-await is off because async-by-contract methods (interface implementations, MCP handlers) legitimately return promises without awaiting anything.
- **eslint.config.cjs**: The preserve-caught-error rule is off because wrapped errors already embed the original message, and attaching `cause` changes what the CLI prints on failure.
- **eslint.config.cjs**: Root-level TypeScript config files belong to no tsconfig project, so type-aware lint rules are disabled for them via disableTypeChecked.
- **eslint.config.cjs testFiles**: Type-safety lint rules are disabled in tests because vi.fn()/vi.mocked() yield any, mock implementations are async, methods are passed unbound to expect() and vi.mocked(), and casts document intent; the rules only add noise there.
- **eslint.config.cjs testFiles**: In tests no-misused-promises skips void-return checks for arguments because mockImplementation is typed to return void but is routinely given async implementations.

### `scripts/coverage-summary.mjs`

- **scripts/coverage-summary.mjs**: scripts/coverage-summary.mjs prints vitest's json-summary totals as a Markdown table for the PR workflow's job summary (appended to GITHUB_STEP_SUMMARY); it takes an optional path, defaulting to coverage/coverage-summary.json.
- **scripts/coverage-summary.mjs**: When the coverage summary file cannot be read (tests may have failed before writing it), the script prints a note and exits 0 rather than failing the CI step.

### `scripts/finalize-declarations.mjs`

- **scripts/finalize-declarations.mjs**: tsc emits a .d.ts for every module the public entry pulls in (even value-only imports) and writes relative specifiers without extensions, which NodeNext consumers refuse in an ESM package and which silently become any under skipLibCheck. After `tsc -p tsconfig.types.json`, the script walks the declaration graph from dist/public-types.d.ts, rewrites each relative specifier to its .js path, and deletes every unreachable .d.ts.
- **scripts/finalize-declarations.mjs RELATIVE_SPECIFIER**: RELATIVE_SPECIFIER matches both `from "./x"` (import/export from) and `import("./x")` (type queries) so both forms are rewritten and followed.

### `scripts/smoke-test.mjs`

- **scripts/smoke-test.mjs**: The vitest suite imports TypeScript sources, so nothing else exercises what npm install delivers: bin shims, esbuild bundles (externals, version define, shared chunk), public declarations and the tarball contents. A dependency that bundles fine but throws at import time would otherwise ship with green CI. `pnpm smoke` runs after `pnpm build`, every check in an empty temp directory with HOME and config lookup pointed away from the real environment.
- **scripts/smoke-test.mjs exportTargets**: exportTargets collects every file path package.json exports maps to and strips the leading './' because npm pack lists paths without it.
- **scripts/smoke-test.mjs FORBIDDEN_TARBALL_SUFFIXES**: Source maps are deliberately not published (esbuild sourcemap: false, tsconfig declarationMap: false). A .map in the tarball means one was switched back on or dist/ holds output from an earlier build, since tsc does not delete files it no longer emits.
- **scripts/smoke-test.mjs MAX_TARBALL_UNPACKED_BYTES**: The tarball file and byte ceilings exist so growth is noticed rather than shipped: the byte ceiling absorbs ordinary growth but trips on step changes of 0.1 MB or more (a dependency no longer external, splitting off, source maps back, all module declarations reappearing). Raise it only for ordinary growth and say so. Only dist/*.js, the public .d.ts files and README.md cost bytes; esbuild keeps comments that lead object/array/class members but drops statement-leading ones, so rationale is free in function bodies, at module scope or in changesets.
- **scripts/smoke-test.mjs withTimeout**: withTimeout takes details as a function evaluated when the timeout fires, so a hung process still reports whatever it logged up to that point.
- **scripts/smoke-test.mjs run**: The smoke test's run helper kills the child on timeout and resolves on `close` rather than `exit`, so stdout and stderr are fully drained before the result is inspected.
- **scripts/smoke-test.mjs checkCliVersion**: The CLI version check runs through the bin shim so the whole CLI bundle is imported with its external dependencies resolved from node_modules before yargs exits.
- **scripts/smoke-test.mjs checkMcpHandshake**: The MCP handshake check spawns the bin shim, which is what an MCP client's sync-worktrees-mcp command runs, so dist/mcp-server.js and its shared chunk are exercised.
- **scripts/smoke-test.mjs checkMcpHandshake**: Writing to the MCP server after it died raises EPIPE on stdin; the stream error is ignored because the exit itself is what gets reported.
- **scripts/smoke-test.mjs checkMcpHandshake**: The handshake check waits for `close`, which fires after `exit` once stdout and stderr are drained, so captured stderr is complete when an exit is reported.
- **scripts/smoke-test.mjs checkMcpHandshake**: The exit promise gets a no-op catch so an early server exit does not surface as an unhandled rejection; whichever request await is in flight reports it.
- **scripts/smoke-test.mjs checkMcpHandshake**: The MCP serverInfo.version comes from the esbuild __SYNC_WORKTREES_VERSION__ define, so asserting it equals package.json's version verifies the define in the shipped bundle.
- **scripts/smoke-test.mjs checkTarballContents**: The tarball check uses `npm pack --dry-run --json` because it applies package.json `files` exactly as publish does.
- **scripts/smoke-test.mjs checkTarballContents**: `npm pack --json` printed an array up to npm 11 and an object keyed by package name from npm 12. The release job pins npm@11 (OIDC trusted publishing needs >= 11.5.1) while local and PR runs use whatever npm ships with Node, so the check accepts both shapes.
- **scripts/smoke-test.mjs checkNoStaleChunks**: Chunk names are content hashes, so a dist/ not cleaned before rebuild keeps old chunks that npm pack ships; every shipped dist/*.js must be an entry or a chunk an entry imports.
- **scripts/smoke-test.mjs checkPublicTypes**: The public types are checked the way a consumer uses them: a config with `@satisfies {import("sync-worktrees").SyncWorktreesConfig}`, resolved through package.json exports under NodeNext without skipLibCheck, and a misspelled key must be caught so types that degrade to any fail.
- **scripts/smoke-test.mjs checkPublicTypes**: tsc prints paths relative to the real cwd, and when the temp dir sits behind a symlink (macOS /var/folders -> /private/var/folders) the path climbs out and back in, so errors are matched by file name rather than a bare prefix.

### `src/cli/doctor.ts`

- **DOCTOR_MIN_NODE_MAJOR**: The minimum Node.js major appears in package.json engines, in bin/node-version.js for the start-up warning, and in the doctor command; tests assert all three agree.

### `src/public-types.ts`

- **public-types module**: src/public-types.ts is the package's public type surface, what import of sync-worktrees resolves to for TypeScript and JSDoc satisfies annotations in config files. package.json exports types point at its emitted declaration, and tsconfig.types.json emits declarations only for it and what it imports; everything else in src is internal.

### `src/services/worktree-status.service.ts`

- **StashListing**: StashListing is a structural interface rather than simple-git's type because RefScanScope, which references it, is part of the public typings.

### `src/types/globals.d.ts`

- **__SYNC_WORKTREES_VERSION__**: The package version is injected at build time by esbuild.config.js and vitest.config.ts as a define from package.json's version, instead of importing package.json, so esbuild does not inline the whole manifest into the shipped dist/mcp-server.js bundle.

### `vitest.config.ts`

- **vitest.config**: Test include patterns are set on each vitest project rather than the root, because a project that extends the root config concatenates its include list onto the root's instead of replacing it.
- **vitest.config coverage**: The json-summary coverage reporter is enabled because scripts/coverage-summary.mjs reads it to write coverage totals into the PR job summary.
- **vitest.config coverage.thresholds**: Coverage thresholds sit about 3 points under the Linux totals because the other OS CI legs skip a few suites.

### Tests

Why the tests that pin these decisions are built the way they are.

#### `src/__tests__/node-version.test.ts`

- **bin/node-version.js**: bin/ is plain JavaScript shipped as-is without compilation, so its tests load it with a dynamic import by file URL rather than through a typed import.

#### `src/__tests__/unit-project-build-free.test.ts`

- **vitest.config.ts projects**: vitest.config.ts splits tests into unit and integration projects, run by `pnpm test:unit` without a build, and an e2e project under src/__tests__/e2e/ run by `pnpm test:e2e` after building. A test that spawns the bundled CLI must live in the e2e directory or test:unit fails on a fresh checkout, and a test that does not must live elsewhere or test:unit silently skips it.
- **BUILD_OUTPUT_REFERENCE**: A test counts as needing a build when it references a bundle entry point from esbuild.config.js (dist/index.js or dist/mcp-server.js, as a path string or path.join segments) or a bin shim (bin/sync-worktrees.js, bin/sync-worktrees-mcp.js), since the shims import the bundle.

## Consequences

Changing code covered by an entry here means updating the entry in the same pull request. An entry that no longer holds is deleted, or superseded by a new numbered ADR when the reversal is itself a decision worth keeping.
