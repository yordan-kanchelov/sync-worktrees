import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const outdir = fileURLToPath(new URL("./dist/", import.meta.url));
const watch = process.argv.includes("--watch");

// One build for both entry points: with `splitting`, the modules the CLI and
// the MCP server share (src/utils, src/services, ...) are emitted once into
// dist/chunk-*.js instead of being bundled into each entry. The entries keep
// their names, so bin/sync-worktrees.js loads dist/index.js and
// bin/sync-worktrees-mcp.js loads dist/mcp-server.js.
const buildOptions = {
  entryPoints: {
    index: "src/index.ts",
    "mcp-server": "src/mcp/index.ts",
  },
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // Not minified: stack traces and the redacted error output users paste into
  // issues stay readable, and the shared chunk already removes the duplication
  // that made up most of the size.
  //
  // No source maps: Node only applies them with --enable-source-maps, src/ is
  // not published, and they would add ~0.5 MB (mappings only) or ~1.5 MB (with
  // sourcesContent) to the package. scripts/smoke-test.mjs carries the
  // tarball's current size and the ceiling that guards it; it is not restated
  // here, so that the two cannot drift apart.
  sourcemap: false,
  packages: "external",
  define: {
    __SYNC_WORKTREES_VERSION__: JSON.stringify(version),
  },
  logLevel: watch ? "info" : "warning",
};

// Start from an empty dist/: chunk names are content hashes, so without this a
// rebuild would leave the previous build's chunks behind and `npm pack` would
// ship them.
rmSync(outdir, { recursive: true, force: true });

try {
  if (watch) {
    const context = await esbuild.context(buildOptions);
    await context.watch();
  } else {
    await esbuild.build(buildOptions);
    console.log("Build completed successfully!");
  }
} catch (error) {
  console.error("Build failed:");
  console.error(error.message || error);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
}
