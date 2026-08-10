import { readFileSync } from "node:fs";
import path from "path";

import { defineConfig } from "vitest/config";

const { version } = JSON.parse(readFileSync(path.resolve(__dirname, "./package.json"), "utf8"));

export default defineConfig({
  define: {
    __SYNC_WORKTREES_VERSION__: JSON.stringify(version),
  },
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["node_modules", "dist", "**/*.skip"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
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
  },
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src"),
    },
  },
});
