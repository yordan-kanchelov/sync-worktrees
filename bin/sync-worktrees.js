#!/usr/bin/env node

import process from "node:process";

process.env.NODE_ENV ??= "production";
await import("../dist/index.js");
