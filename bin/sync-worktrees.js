#!/usr/bin/env node

import process from "node:process";

process.env.NODE_ENV ??= "production";
const { main } = await import("../dist/index.js");

await main().catch((error) => {
  console.error("❌ Unhandled error:", error);
  process.exit(1);
});
