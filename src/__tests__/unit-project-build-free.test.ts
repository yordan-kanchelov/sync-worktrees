import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// vitest.config.ts splits the suite into a "unit" project (everything outside
// src/__tests__/e2e/, run by `pnpm test:unit` with no build) and an "e2e" project
// (`pnpm test:e2e`, which builds first). A test that spawns the bundled CLI only
// works after a build, so it has to live in the e2e directory, or `test:unit`
// fails on a fresh checkout.

const SRC = path.resolve(__dirname, "..");
const E2E_DIR = path.join(SRC, "__tests__", "e2e");

// A path to a bundle entry point (esbuild.config.js: index, mcp-server) written as
// "dist/index.js" or path.join(…, "dist", "index.js"), or a bin shim (which imports
// the bundle) as a string.
const BUILD_OUTPUT_REFERENCE =
  /\bdist\/(?:index|mcp-server)\.js|["'`]dist["'`]\s*,\s*["'`](?:index|mcp-server)\.js|bin\/sync-worktrees(?:-mcp)?\.js["'`]/;

function testFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.test\.tsx?$/.test(file))
    .map((file) => path.join(SRC, file))
    .filter((file) => file !== __filename);
}

describe("unit project stays build-free", () => {
  it("matches the way the e2e suites reach the built CLI", () => {
    // Guards the pattern itself: if the e2e suites stop matching it, the check below proves nothing.
    const e2eMatches = testFiles().filter(
      (file) => file.startsWith(E2E_DIR + path.sep) && BUILD_OUTPUT_REFERENCE.test(readFileSync(file, "utf8")),
    );
    expect(e2eMatches.length).toBeGreaterThan(0);
  });

  it("keeps every test that runs the built CLI under src/__tests__/e2e/", () => {
    const offenders = testFiles()
      .filter((file) => !file.startsWith(E2E_DIR + path.sep))
      .filter((file) => BUILD_OUTPUT_REFERENCE.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
