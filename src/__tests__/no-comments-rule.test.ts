import { createRequire } from "node:module";

import type { Rule } from "eslint";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";

const rule = createRequire(import.meta.url)("../../eslint-rules/no-comments.cjs") as Rule.RuleModule;

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const error = { messageId: "noComment" };

ruleTester.run("no-comments", rule, {
  valid: [
    "#!/usr/bin/env node\nexport const x = 1;",
    "// eslint-disable-next-line no-console\nconsole.log(1);",
    "/* eslint-disable no-console */\nconsole.log(1);",
    "// @ts-expect-error deliberate\nconst a: number = 'x';",
    "// @ts-check\nconst a = 1;",
    "/** @type {import('x').Y} */\nconst a = {};",
    '/** @satisfies {import("sync-worktrees").SyncWorktreesConfig} */\nexport default {};',
    '/// <reference types="node" />\nconst a = 1;',
    "/** @vitest-environment node */\nconst a = 1;",
    "// prettier-ignore\nconst a = [1,2];",
    "/* v8 ignore next */\nconst a = 1;",
  ],
  invalid: [
    { code: "// explains the next line\nconst a = 1;", errors: [error] },
    { code: "const a = 1; // trailing", errors: [error] },
    { code: "/* block */\nconst a = 1;", errors: [error] },
    { code: "/** The answer. */\nexport const answer = 42;", errors: [error] },
    { code: "/**\n * @param x the input\n */\nfunction f(x: number) { return x; }", errors: [error] },
    { code: "// TODO: fix\n// second line\nconst a = 1;", errors: [error, error] },
    { code: "/** @type {string} and some prose */ const a = '';", errors: [error] },
  ],
});
