#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ESLint } from "eslint";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex === -1 ? null : args.splice(outIndex, 2)[1];
const patterns = args.length > 0 ? args : ["**/*.{js,cjs,mjs,ts,tsx}"];

const eslint = new ESLint({
  ruleFilter: ({ ruleId }) => ruleId === "local/no-comments",
  overrideConfig: { linterOptions: { reportUnusedDisableDirectives: "off" } },
});
const results = await eslint.lintFiles(patterns);

function offsetsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (line, column) => starts[line - 1] + column - 1;
}

const comments = [];
for (const result of results) {
  const messages = result.messages.filter((m) => m.ruleId === "local/no-comments");
  if (messages.length === 0) continue;
  const file = path.relative(process.cwd(), result.filePath);
  const text = readFileSync(result.filePath, "utf8");
  const offset = offsetsOf(text);
  const lineText = (line) => text.split("\n")[line - 1];
  let previous = null;
  for (const m of messages) {
    const start = offset(m.line, m.column);
    const end = offset(m.endLine, m.endColumn);
    const body = text.slice(start, end);
    const ownLine =
      lineText(m.line)
        .slice(0, m.column - 1)
        .trim() === "";
    const isLine = body.startsWith("//");
    if (previous && isLine && previous.isLine && ownLine && previous.ownLine && m.line === previous.endLine + 1) {
      previous.endLine = m.endLine;
      previous.end = end;
      previous.text = text.slice(previous.start, end);
      continue;
    }
    previous = {
      id: `${file}:${m.line}`,
      file,
      line: m.line,
      endLine: m.endLine,
      start,
      end,
      ownLine,
      isLine,
      text: body,
    };
    comments.push(previous);
  }
}

for (const c of comments) delete c.isLine;
const json = JSON.stringify(comments, null, 1);
if (out) writeFileSync(out, json);
else process.stdout.write(json);
const lines = comments.reduce((n, c) => n + (c.ownLine ? c.endLine - c.line + 1 : 0), 0);
process.stderr.write(`${comments.length} comment blocks, ${lines} whole lines of comments\n`);
