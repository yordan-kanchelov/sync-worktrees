import { readFileSync } from "node:fs";
import path from "path";

import { defineConfig } from "vitest/config";

const TEST_FILES = ["src/**/*.test.ts", "src/**/*.test.tsx"];
// The suites under this directory spawn the bundled CLI (dist/); everything else is a unit test.
const E2E_DIR = "src/__tests__/e2e";

const { version } = JSON.parse(readFileSync(path.resolve(__dirname, "./package.json"), "utf8"));

export default defineConfig({
  define: {
    __SYNC_WORKTREES_VERSION__: JSON.stringify(version),
  },
  test: {
    globals: false,
    environment: "node",
    // `include` lives on each project: a project that extends this config would
    // concatenate its own list onto a root one, not replace it.
    exclude: ["node_modules", "dist", "**/*.skip"],
    coverage: {
      provider: "v8",
      // json-summary feeds the PR job summary (scripts/coverage-summary.mjs).
      reporter: ["text", "lcov", "html", "json-summary"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.d.ts", "src/index.ts", "src/utils/cli.ts", "src/**/__tests__/**", "src/**/__mocks__/**"],
      thresholds: {
        branches: 74,
        functions: 73,
        lines: 79,
        statements: 79,
      },
    },
    setupFiles: ["./src/__tests__/setup.ts"],
    testTimeout: 40000,
    hookTimeout: 40000,
    // `pnpm test` runs both projects. `pnpm test:unit` (--project unit) needs no build;
    // `pnpm test:e2e` (--project e2e) builds first. unit-project-build-free.test.ts keeps
    // unit tests out of dist/.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: TEST_FILES,
          exclude: [`${E2E_DIR}/**`],
        },
      },
      {
        extends: true,
        test: {
          name: "e2e",
          include: [`${E2E_DIR}/**/*.test.ts`, `${E2E_DIR}/**/*.test.tsx`],
        },
      },
    ],
  },
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src"),
    },
  },
});
