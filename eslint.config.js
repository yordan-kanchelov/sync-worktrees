const js = require("@eslint/js");
const tseslint = require("@typescript-eslint/eslint-plugin");
const tseslintParser = require("@typescript-eslint/parser");
const eslintPluginImport = require("eslint-plugin-import");
const prettierPlugin = require("eslint-plugin-prettier");
const globals = require("globals");

const baseTypescriptRules = {
  // Prettier integration
  "prettier/prettier": ["error"],

  // Import organization
  "import/order": [
    "error",
    {
      groups: ["builtin", "external", "internal", "parent", "sibling", "index", "type"],
      "newlines-between": "always",
      alphabetize: { order: "asc", caseInsensitive: true },
    },
  ],
  "sort-imports": ["error", { ignoreDeclarationSort: true }],
  "import/no-unresolved": ["off"],

  // TypeScript specific rules
  "@typescript-eslint/explicit-function-return-type": "warn",
  "@typescript-eslint/no-explicit-any": "warn",
  "@typescript-eslint/no-unused-vars": ["error", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
  "@typescript-eslint/consistent-type-imports": [
    "error",
    {
      prefer: "type-imports",
      fixStyle: "separate-type-imports",
    },
  ],
};

module.exports = [
  // Base ESLint recommended configuration
  js.configs.recommended,

  // TypeScript files - base configuration
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslintParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: "./tsconfig.json",
      },
      globals: {
        ...globals.node,
        NodeJS: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "import": eslintPluginImport,
      "prettier": prettierPlugin,
    },
    settings: {
      "import/parsers": {
        "@typescript-eslint/parser": [".ts"],
      },
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
          project: "./tsconfig.json",
        },
        node: {
          extensions: [".js", ".ts"],
        },
      },
    },
    rules: {
      ...baseTypescriptRules,
      // Override some base rules for TypeScript
      "no-unused-vars": "off", // Use @typescript-eslint/no-unused-vars instead
      "no-undef": "off", // TypeScript handles this
    },
  },

  // Test files - relaxed rules
  {
    files: ["**/__tests__/**/*.ts", "**/*.test.ts", "**/*.spec.ts"],
    languageOptions: {
      globals: {
        ...globals.jest,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },

  // JavaScript config files
  {
    files: ["eslint.config.js", "jest.config.js", "sync-worktrees.config*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        module: "writable",
        require: "readonly",
        process: "readonly",
      },
    },
  },

  // Files to ignore
  {
    ignores: [
      "**/dist/",
      "**/coverage/",
      "**/node_modules/",
      "**/.git/",
      "**/build/",
    ],
  },
];