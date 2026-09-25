#!/usr/bin/env node
// Prints vitest's json-summary coverage totals as a Markdown table, for the PR
// workflow's job summary: `node scripts/coverage-summary.mjs >> "$GITHUB_STEP_SUMMARY"`.
// Usage: node scripts/coverage-summary.mjs [coverage/coverage-summary.json]
import { readFileSync } from "node:fs";

const METRICS = [
  ["lines", "Lines"],
  ["statements", "Statements"],
  ["functions", "Functions"],
  ["branches", "Branches"],
];

function formatCoverageSummary(summary) {
  const rows = METRICS.map(([key, label]) => {
    const { covered, total, pct } = summary.total[key];
    const percent = typeof pct === "number" ? `${pct.toFixed(2)}%` : "n/a";
    return `| ${label} | ${percent} | ${covered} / ${total} |`;
  });
  const header = ["## Coverage", "", "| Metric | Coverage | Covered / Total |", "| --- | ---: | ---: |"];
  return [...header, ...rows, ""].join("\n");
}

const file = process.argv[2] ?? "coverage/coverage-summary.json";
let summary;
try {
  summary = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  // The tests may have failed before coverage was written; say so rather than failing the step.
  console.log(`## Coverage\n\nNo coverage summary at \`${file}\` (${error.code ?? error.message}).\n`);
  process.exit(0);
}
console.log(formatCoverageSummary(summary));
