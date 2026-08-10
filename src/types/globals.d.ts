/**
 * Injected at build time by `esbuild.config.js` (bundle) and `vitest.config.ts`
 * (tests) from the `version` field of package.json. Using a define instead of
 * `import packageJson from "../../package.json"` keeps esbuild from inlining
 * the entire manifest — scripts, devDependencies and all — into the shipped
 * `dist/mcp-server.js` bundle just to read one string.
 */
declare const __SYNC_WORKTREES_VERSION__: string;
