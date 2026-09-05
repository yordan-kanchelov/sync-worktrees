const js = require("@eslint/js");
const { defineConfig } = require("eslint/config");
const reactHooks = require("eslint-plugin-react-hooks");
const globals = require("globals");
const tseslint = require("typescript-eslint");

const testFiles = [
  "src/**/__tests__/**/*.{ts,tsx}",
  "src/**/__mocks__/**/*.{ts,tsx}",
  "src/**/*.test.{ts,tsx}",
  "src/**/*.spec.{ts,tsx}",
];

module.exports = defineConfig([
  {
    ignores: ["**/dist/", "**/coverage/", "**/node_modules/", "**/.astro/", "**/.git/", "**/build/", "site/"],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,cjs,mjs}"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // tsconfig.json covers the src/ sources, tsconfig.spec.json covers tests and mocks.
        project: ["./tsconfig.json", "./tsconfig.spec.json"],
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      // Async-by-contract methods (interface implementations, MCP handlers) return promises without awaiting.
      "@typescript-eslint/require-await": "off",
      // Wrapped errors already embed the original message; attaching `cause` changes what the CLI prints on failure.
      "preserve-caught-error": "off",
    },
  },
  {
    // Ink components and their tests.
    files: ["src/components/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      // React Compiler rules: the existing ref-during-render and setState-in-effect patterns predate the linter
      // and changing them alters render behaviour, so they are off until those components are reworked.
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // Root-level TypeScript config files belong to no tsconfig project.
    files: ["*.ts"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Test doubles: vi.fn()/vi.mocked() yield `any`, mock implementations are async, methods are passed unbound
    // to expect() and vi.mocked(), and casts document intent. These rules only add noise in tests.
    files: testFiles,
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",
      // `mockImplementation` is typed to return void but is routinely given async implementations.
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
    },
  },
]);
