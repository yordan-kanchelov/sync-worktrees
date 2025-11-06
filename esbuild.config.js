import * as esbuild from "esbuild";

try {
  await esbuild.build({
    entryPoints: ["src/index.ts"],
    outfile: "dist/index.js",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    packages: "external",
    alias: {
      "react-devtools-core": "./devtools-stub.js",
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
