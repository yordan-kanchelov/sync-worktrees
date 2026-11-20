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
