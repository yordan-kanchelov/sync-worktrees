#!/usr/bin/env node
// Runs after `tsc -p tsconfig.types.json` (see the `build` script) and leaves
// dist/ with exactly the declarations package.json `exports["."].types` needs.
//
// tsc writes a .d.ts for every module the public entry pulls into the program,
// including modules that only its *values* import, so most of what it emits is
// unreachable from dist/public-types.d.ts. It also writes relative specifiers
// exactly as the sources spell them, without an extension, which a consumer
// resolving with `moduleResolution: "nodenext"` refuses in an ESM package —
// and with `skipLibCheck` on, the types behind them silently become `any`.
//
// So: walk the declaration graph from the entry, rewrite each relative
// specifier to the `.js` path Node would load, and delete every .d.ts the walk
// did not reach.

import { existsSync } from "node:fs";
import { readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
const entry = path.join(distDir, "public-types.d.ts");

// `from "./x"` (import/export ... from) and `import("./x")` (type queries).
const RELATIVE_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.\.?\/[^"']*)\2/g;

function resolveSpecifier(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  if (specifier.endsWith(".js") && existsSync(`${base.slice(0, -".js".length)}.d.ts`)) {
    return { specifier, target: `${base.slice(0, -".js".length)}.d.ts` };
  }
  if (existsSync(`${base}.d.ts`)) {
    return { specifier: `${specifier}.js`, target: `${base}.d.ts` };
  }
  if (existsSync(path.join(base, "index.d.ts"))) {
    return { specifier: `${specifier}/index.js`, target: path.join(base, "index.d.ts") };
  }
  throw new Error(`${path.relative(distDir, fromFile)}: cannot resolve "${specifier}" to a declaration file`);
}

async function listDeclarations(dir) {
  const found = [];
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) found.push(...(await listDeclarations(full)));
    else if (dirent.name.endsWith(".d.ts")) found.push(full);
  }
  return found;
}

async function removeEmptyDirs(dir) {
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    if (dirent.isDirectory()) await removeEmptyDirs(path.join(dir, dirent.name));
  }
  if (dir !== distDir && (await readdir(dir)).length === 0) await rmdir(dir);
}

if (!existsSync(entry)) {
  console.error(`Missing ${path.relative(process.cwd(), entry)}: run \`tsc -p tsconfig.types.json\` first.`);
  process.exit(1);
}

const reachable = new Set();
const queue = [entry];
while (queue.length > 0) {
  const file = queue.pop();
  if (reachable.has(file)) continue;
  reachable.add(file);
  const source = await readFile(file, "utf8");
  const rewritten = source.replace(RELATIVE_SPECIFIER, (_match, lead, quote, specifier) => {
    const resolved = resolveSpecifier(file, specifier);
    queue.push(resolved.target);
    return `${lead}${quote}${resolved.specifier}${quote}`;
  });
  if (rewritten !== source) await writeFile(file, rewritten);
}

const unreachable = (await listDeclarations(distDir)).filter((file) => !reachable.has(file));
await Promise.all(unreachable.map((file) => rm(file)));
await removeEmptyDirs(distDir);

console.log(`Declarations: kept ${reachable.size}, removed ${unreachable.length} unreachable from public-types.d.ts.`);
