#!/usr/bin/env node

import process from "node:process";

import { warnOnUnsupportedNode } from "./node-version.js";

// stderr only: stdout is the MCP stdio transport.
warnOnUnsupportedNode("sync-worktrees-mcp");

process.env.NODE_ENV ??= "production";
// The server starts when the bundle is imported and runs until the client
// closes stdin.
await import("../dist/mcp-server.js");
