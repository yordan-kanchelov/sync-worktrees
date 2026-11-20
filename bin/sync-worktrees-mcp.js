#!/usr/bin/env node

import process from "node:process";

import { warnOnUnsupportedNode } from "./node-version.js";

warnOnUnsupportedNode("sync-worktrees-mcp");

process.env.NODE_ENV ??= "production";
await import("../dist/mcp-server.js");
