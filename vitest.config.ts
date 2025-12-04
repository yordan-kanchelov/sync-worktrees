import path from "path";

import { defineConfig } from "vitest/config";

export default defineConfig({
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
        functions: 75,
        lines: 80,
        statements: 80,
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
