#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const [listingPath, classificationPath] = process.argv.slice(2);
if (!listingPath || !classificationPath) {
  process.stderr.write("usage: delete-comments.mjs <listing.json> <classification.jsonl>\n");
  process.exit(1);
}

const listing = new Map(JSON.parse(readFileSync(listingPath, "utf8")).map((c) => [c.id, c]));
const verdicts = readFileSync(classificationPath, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));

const byFile = new Map();
const skipped = [];
for (const verdict of verdicts) {
  if (verdict.unsure) {
    skipped.push(`${verdict.id} (unsure)`);
    continue;
  }
  const comment = listing.get(verdict.id);
  if (!comment) {
    skipped.push(`${verdict.id} (not in listing)`);
    continue;
  }
  if (!byFile.has(comment.file)) byFile.set(comment.file, []);
  byFile.get(comment.file).push(comment);
}

let removedLines = 0;
for (const [file, comments] of byFile) {
  let text = readFileSync(file, "utf8");
  for (const c of comments.sort((a, b) => b.start - a.start)) {
    if (text.slice(c.start, c.end) !== c.text) {
      skipped.push(`${c.id} (file changed since listing)`);
      continue;
    }
    let start = c.start;
    let end = c.end;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const jsx = /\{\s*$/.exec(before) && /^\s*\}/.exec(after);
    if (jsx) {
      start = before.lastIndexOf("{");
      end += after.indexOf("}") + 1;
    }
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const nextNewline = text.indexOf("\n", end);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline;
    const leading = text.slice(lineStart, start);
    const trailing = text.slice(end, lineEnd);
    if (leading.trim() === "" && trailing.trim() === "") {
      removedLines += text.slice(lineStart, lineEnd).split("\n").length;
      text = text.slice(0, lineStart) + text.slice(nextNewline === -1 ? lineEnd : lineEnd + 1);
    } else if (trailing.trim() === "") {
      text = text.slice(0, start).replace(/[ \t]+$/, "") + text.slice(end);
    } else {
      text = text.slice(0, start) + text.slice(end).replace(/^[ \t]+/, leading.trim() === "" ? "" : " ");
    }
  }
  writeFileSync(file, text);
}

process.stdout.write(`${byFile.size} files edited, ${removedLines} whole lines removed\n`);
if (skipped.length > 0) process.stdout.write(`skipped ${skipped.length}:\n  ${skipped.join("\n  ")}\n`);
