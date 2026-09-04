import { readFileSync } from "node:fs";

import * as esbuild from "esbuild";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const commonConfig = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // No source maps: Node only applies them with --enable-source-maps, src/ is
  // not published, and they would add ~0.5 MB (mappings only) or ~1.5 MB (with
  // sourcesContent) to a package that is otherwise under 1 MB unpacked.
  sourcemap: false,
  packages: "external",
  define: {
    __SYNC_WORKTREES_VERSION__: JSON.stringify(version),
  },
};

try {
  await esbuild.build({
    ...commonConfig,
    entryPoints: ["src/index.ts"],
    outfile: "dist/index.js",
    alias: {
      "react-devtools-core": "./devtools-stub.js",
    },
  });

  await esbuild.build({
    ...commonConfig,
    entryPoints: ["src/mcp/index.ts"],
    outfile: "dist/mcp-server.js",
    banner: {
      js: "#!/usr/bin/env node",
    },
  });

  console.log("Build completed successfully!");
} catch (error) {
  console.error("Build failed:");
  console.error(error.message || error);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
}
