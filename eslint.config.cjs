const js = require("@eslint/js");
const { defineConfig } = require("eslint/config");
const reactHooks = require("eslint-plugin-react-hooks");
const globals = require("globals");
const tseslint = require("typescript-eslint");

const noComments = require("./eslint-rules/no-comments.cjs");

const testFiles = ["src/**/__tests__/**/*.{ts,tsx}", "src/**/*.test.{ts,tsx}"];

module.exports = defineConfig([
  {
    ignores: [
      "**/dist/",
      "**/coverage/",
      "**/node_modules/",
      "**/.astro/",
      "**/.git/",
      "**/build/",
      "site/",
      "tmp-e2e-*/",
      ".mcp-stdio-test-*/",
    ],
  },
  js.configs.recommended,
  {
    plugins: { local: { rules: { "no-comments": noComments } } },
    rules: { "local/no-comments": "error", "no-empty": ["error", { allowEmptyCatch: true }] },
  },
  {
    files: ["src/types/public-config.ts", "sync-worktrees.config.example.js"],
    rules: { "local/no-comments": "off" },
  },
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
      "@typescript-eslint/require-await": "off",
      "preserve-caught-error": "off",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: testFiles,
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "LogicalExpression[right.type='MemberExpression'][right.property.name='repoUrl']",
          message: "A raw repoUrl as a fallback label can leak credentials: use repoDisplayLabel() from utils/git-url.",
        },
        {
          selector: "TemplateLiteral > MemberExpression.expressions[property.name='repoUrl']",
          message: "Interpolating a raw repoUrl can leak credentials: wrap it in redactRepoUrl() from utils/git-url.",
        },
        {
          selector: "BinaryExpression[operator='+'] > MemberExpression[property.name='repoUrl']",
          message: "Concatenating a raw repoUrl can leak credentials: wrap it in redactRepoUrl() from utils/git-url.",
        },
      ],
    },
  },
  {
    files: ["src/components/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    files: ["*.ts"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
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
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
    },
  },
]);
