#!/usr/bin/env node

import process from "node:process";

import { warnOnUnsupportedNode } from "./node-version.js";

warnOnUnsupportedNode("sync-worktrees");

process.env.NODE_ENV ??= "production";
if (process.env.NO_COLOR && process.env.FORCE_COLOR === undefined) {
  process.env.FORCE_COLOR = "0";
}
const { main, reportUnhandledError } = await import("../dist/index.js");

await main().catch((error) => {
  reportUnhandledError(error);
  process.exit(1);
});
