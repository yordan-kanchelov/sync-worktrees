import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const outdir = fileURLToPath(new URL("./dist/", import.meta.url));
const watch = process.argv.includes("--watch");

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
  sourcemap: false,
  packages: "external",
  define: {
    __SYNC_WORKTREES_VERSION__: JSON.stringify(version),
  },
  logLevel: watch ? "info" : "warning",
};

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
