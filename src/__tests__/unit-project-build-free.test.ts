import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");
const E2E_DIR = path.join(SRC, "__tests__", "e2e");

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

  it("keeps only tests that run the built CLI under src/__tests__/e2e/", () => {
    const strays = testFiles()
      .filter((file) => file.startsWith(E2E_DIR + path.sep))
      .filter((file) => !BUILD_OUTPUT_REFERENCE.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));
    expect(strays).toEqual([]);
  });
});
