// Runtime check for the Node.js floor in package.json `engines`. npm only
// warns (EBADENGINE) when `engines` is not met, and that warning scrolls past
// in the install log, so an older Node reaches the bundles anyway. This names
// the problem when the command starts instead of leaving it to whatever breaks
// first. It warns rather than exits: most commands still work on Node 22, which
// is simply no longer tested.
//
// src/__tests__/node-version.test.ts keeps MIN_NODE_MAJOR in step with
// `engines.node`.

import process from "node:process";

export const MIN_NODE_MAJOR = 24;

export function nodeVersionWarning(version, program) {
  const major = Number.parseInt(String(version).split(".")[0], 10);
  if (!(major < MIN_NODE_MAJOR)) return null;
  return (
    `${program}: Node.js ${MIN_NODE_MAJOR} or newer is required, but this is Node.js ${version}. ` +
    `Continuing, but some features may not work. Upgrade Node.js, or use sync-worktrees@5 on Node 22.`
  );
}

export function warnOnUnsupportedNode(program) {
  const warning = nodeVersionWarning(process.versions.node, program);
  if (warning) process.stderr.write(`${warning}\n`);
}
