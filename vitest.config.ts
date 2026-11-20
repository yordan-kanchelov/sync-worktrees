import { readFileSync } from "node:fs";
import path from "path";

import { defineConfig } from "vitest/config";

const TEST_FILES = ["src/**/*.test.ts", "src/**/*.test.tsx"];
const E2E_DIR = "src/__tests__/e2e";
const INTEGRATION_DIR = "src/__tests__/integration";

const { version } = JSON.parse(readFileSync(path.resolve(__dirname, "./package.json"), "utf8"));

export default defineConfig({
  define: {
    __SYNC_WORKTREES_VERSION__: JSON.stringify(version),
  },
  test: {
    globals: false,
    environment: "node",
    exclude: ["node_modules", "dist"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html", "json-summary"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.d.ts", "src/**/__tests__/**"],
      thresholds: {
        branches: 84,
        functions: 89,
        lines: 90,
        statements: 89,
      },
    },
    setupFiles: ["./src/__tests__/setup.ts"],
    testTimeout: 40000,
    hookTimeout: 40000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: TEST_FILES,
          exclude: [`${E2E_DIR}/**`, `${INTEGRATION_DIR}/**`],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: [`${INTEGRATION_DIR}/**/*.test.ts`, `${INTEGRATION_DIR}/**/*.test.tsx`],
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
});
