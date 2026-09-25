#!/usr/bin/env node

import process from "node:process";

import { warnOnUnsupportedNode } from "./node-version.js";

warnOnUnsupportedNode("sync-worktrees");

process.env.NODE_ENV ??= "production";
// chalk (the dashboard's colours) honours FORCE_COLOR but not NO_COLOR, and
// decides once, at import time — so translate before the bundle is loaded.
if (process.env.NO_COLOR && process.env.FORCE_COLOR === undefined) {
  process.env.FORCE_COLOR = "0";
}
const { main, reportUnhandledError } = await import("../dist/index.js");

await main().catch((error) => {
  // Redacts credential-bearing URLs; printing `error` raw here leaked them.
  reportUnhandledError(error);
  process.exit(1);
});
