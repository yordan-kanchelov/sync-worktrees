import * as esbuild from "esbuild";

const commonConfig = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  packages: "external",
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
