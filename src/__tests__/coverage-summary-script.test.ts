import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// scripts/coverage-summary.mjs turns vitest's json-summary into the Markdown
// table that pr.yml appends to the job summary.
const SCRIPT = path.resolve(__dirname, "../../scripts/coverage-summary.mjs");

function run(file: string): string {
  return execFileSync(process.execPath, [SCRIPT, file], { encoding: "utf8" });
}

describe("scripts/coverage-summary.mjs", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("renders the totals as a Markdown table", () => {
    dir = mkdtempSync(path.join(tmpdir(), "coverage-summary-"));
    const file = path.join(dir, "coverage-summary.json");
    const metric = (covered: number, total: number, pct: number | string) => ({ covered, total, skipped: 0, pct });
    writeFileSync(
      file,
      JSON.stringify({
        total: {
          lines: metric(812, 1000, 81.2),
          statements: metric(1623, 2000, 81.15),
          functions: metric(0, 0, "Unknown"),
          branches: metric(3, 4, 75),
        },
        "/repo/src/index.ts": { lines: metric(1, 1, 100) },
      }),
    );

    expect(run(file)).toBe(
      [
        "## Coverage",
        "",
        "| Metric | Coverage | Covered / Total |",
        "| --- | ---: | ---: |",
        "| Lines | 81.20% | 812 / 1000 |",
        "| Statements | 81.15% | 1623 / 2000 |",
        "| Functions | n/a | 0 / 0 |",
        "| Branches | 75.00% | 3 / 4 |",
        "",
        "",
      ].join("\n"),
    );
  });

  it("notes a missing summary instead of failing the step", () => {
    dir = mkdtempSync(path.join(tmpdir(), "coverage-summary-"));
    const missing = path.join(dir, "coverage-summary.json");

    expect(run(missing)).toBe(`## Coverage\n\nNo coverage summary at \`${missing}\` (ENOENT).\n\n`);
  });
});
