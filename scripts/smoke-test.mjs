#!/usr/bin/env node
// Post-build smoke test for the published surface of the package.
//
// The vitest suite imports the TypeScript sources, so nothing else exercises
// what `npm install` actually delivers: the bin shim, the esbuild bundles in
// dist/ (external packages, the version define, the shebang banner) and the
// tarball contents chosen by package.json `files`. A dependency that esbuild
// bundles "successfully" but that throws at import time would otherwise reach
// npm with a green CI. Run it after `pnpm build`: `pnpm smoke`.
//
// Every check runs in an empty temporary directory with HOME and the config
// lookup pointed away from the real environment.

import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const { version } = packageJson;

const CLI_BIN = path.join(repoRoot, "bin", "sync-worktrees.js");
const CLI_BUNDLE = path.join(repoRoot, "dist", "index.js");
const MCP_BUNDLE = path.join(repoRoot, "dist", "mcp-server.js");
const SERVER_NAME = "sync-worktrees";
const SHEBANG = "#!/usr/bin/env node";
// Protocol revision the server serves on the legacy `initialize` path. Both
// `dist/mcp-server.js` (legacy: "serve") and src/mcp/__tests__/server.test.ts
// pin this one; the 2026-07-28 revision uses `server/discover` instead.
const MCP_PROTOCOL_VERSION = "2025-11-25";
// Paths that must be in the tarball (package.json entry points) and path
// prefixes that must not be (sources and tooling that `files` should exclude).
const REQUIRED_TARBALL_PATHS = [packageJson.main, packageJson.types, ...Object.values(packageJson.bin)];
const FORBIDDEN_TARBALL_PREFIXES = ["src/", "scripts/", ".pnpmfile.cjs"];
// Source maps are deliberately not published: esbuild.config.js builds with
// `sourcemap: false` and tsconfig.json has `declarationMap: false`. A map in
// the tarball means one of those was switched back on, or dist/ still holds
// output from an earlier build (tsc does not delete files it no longer emits).
const FORBIDDEN_TARBALL_SUFFIXES = [".map"];
// Ceilings so that tarball growth is noticed rather than shipped. `npm pack`
// reports 86 files and ~1.26 MB unpacked: the two esbuild bundles (~1.07 MB),
// one .d.ts per source module (~0.14 MB) and the README. Ordinary work on this
// codebase moves the total by single-digit kB at a time — the byte ceiling is
// sized to absorb that while still tripping on the step changes it is for: a
// dependency that stops being `external` in esbuild, or source maps coming
// back, either of which adds hundreds of kB at once. Raise it when it is
// ordinary growth that reached it, and say so.
//
// What actually costs bytes: only dist/*.js, the .d.ts files and README.md.
// Tests, changesets and CHANGELOG.md are outside `files` and cost nothing.
// src/utils/* and src/services/* are billed twice, once into each bundle;
// src/mcp/* ships only in mcp-server.js.
//
// Comments are where this note has been wrong twice, in both directions, so
// here is the measured answer: `minify` is off, and esbuild keeps a comment
// that leads a MEMBER of a braced or bracketed member list — an object-literal
// property, an array element, a class field — while dropping one that leads a
// STATEMENT, at module scope or inside a function or method body. Both bundles
// carry well over a thousand `//` lines; a surviving line costs ~75 bytes in
// each bundle it ships in. A `/** */` block is separate: tsc copies it verbatim
// into the .d.ts when it leads a declaration the emitter reaches, by export or
// by being referenced from an exported signature, and never copies `//` or a
// plain `/* */`. So rationale is free in a function body, at module scope, or
// in the changeset, and billed beside an object property or on an exported
// declaration. Both earlier versions of this paragraph generalised from a probe
// that sampled one syntactic position; a claim quantified over all positions
// needs a probe that varies the position.
//
// A bundle delta runs about 45 bytes per line of shipped code, so a ~35-line
// change costs a bit under 2 kB and there is no prose lever that offsets it.
//
// Saying so: raised from 1,400,000 after a run of audit fixes carried the
// tarball to 1,399,065 bytes across 90 files — 935 bytes short of tripping.
// That growth is source on the paths those fixes touched, arriving a few kB at
// a time exactly as described above, not a step change. Restored to roughly
// the original ~140 kB of headroom rather than nudged past the current figure,
// so the next ordinary change does not spend its review arguing with this
// number.
//
// Saying so again: raised from 1,540,000 at 1,499,840 bytes across 90 files,
// with 30 audit items still to implement and a measured ~2.4 kB median per
// item — enough to reach the old ceiling around item 14 and turn an ordinary
// task red for a reason that has nothing to do with it. Checked first that
// this is not the step change the ceiling is for: `packages: "external"` is
// still set in esbuild.config.js, no dependency has been inlined, and the
// no-.map assertion above still passes. Same ~140 kB of headroom as the last
// raise, on the same reasoning.
const MAX_TARBALL_FILES = 120;
const MAX_TARBALL_UNPACKED_BYTES = 1_640_000;
const STEP_TIMEOUT_MS = 10_000;

class SmokeFailure extends Error {}

function smokeFailure(message, details = {}) {
  const extra = Object.entries(details)
    .filter(([, value]) => typeof value === "string" && value.trim() !== "")
    .map(([label, value]) => `\n  ${label}:\n${indent(value.trim())}`)
    .join("");
  return new SmokeFailure(`${message}${extra}`);
}

function fail(message, details) {
  throw smokeFailure(message, details);
}

function indent(text) {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

// `details` is read when the timeout fires, so a hung process still reports
// whatever it logged up to that point.
function withTimeout(promise, ms, what, details = () => ({})) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(smokeFailure(`${what} timed out after ${ms} ms`, details())), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function killIfRunning(child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

function collect(stream) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => (buffer += chunk));
  return () => buffer;
}

// Runs a command to completion, killing it on timeout. Resolves on `close` so
// stdout and stderr are fully drained before the result is inspected.
function run(command, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killIfRunning(child);
    }, STEP_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout: stdout(), stderr: stderr() });
    });
  });
}

function describeExit({ code, signal, timedOut }) {
  if (timedOut) return `killed after ${STEP_TIMEOUT_MS} ms`;
  return signal ? `killed by ${signal}` : `exit code ${code}`;
}

async function checkCliVersion(sandbox) {
  // Goes through the bin shim, so the whole CLI bundle is imported with its
  // external dependencies resolved from node_modules, before yargs exits.
  const result = await run(process.execPath, [CLI_BIN, "--version"], sandbox);
  if (result.code !== 0) {
    fail(`bin/sync-worktrees.js --version failed (${describeExit(result)})`, {
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  const printed = result.stdout.trim();
  if (printed !== version) {
    fail(`bin/sync-worktrees.js --version printed ${JSON.stringify(printed)}, expected ${JSON.stringify(version)}`, {
      stderr: result.stderr,
    });
  }
}

async function checkMcpHandshake(sandbox) {
  const firstLine = (await readFile(MCP_BUNDLE, "utf8")).split("\n", 1)[0];
  if (firstLine !== SHEBANG) {
    fail(`dist/mcp-server.js must start with "${SHEBANG}" (the sync-worktrees-mcp bin runs it directly)`, {
      "first line": firstLine,
    });
  }

  const child = spawn(process.execPath, [MCP_BUNDLE], { ...sandbox, stdio: ["pipe", "pipe", "pipe"] });
  const stderr = collect(child.stderr);
  // A write after the server died raises EPIPE on stdin; the exit itself is
  // what gets reported, so the stream error is not worth a crash.
  child.stdin.on("error", () => {});
  // `close` fires after `exit` once stdout and stderr are drained, so the
  // captured stderr is complete by the time an exit is reported.
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  // Keep an early exit from surfacing as an unhandled rejection: it is
  // reported by whichever await is in flight.
  exited.catch(() => {});

  // Newline-delimited JSON-RPC over stdio: every stdout line must be a
  // JSON-RPC message, since anything else corrupts the transport for clients.
  const pending = new Map();
  let malformed = null;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      malformed ??= new SmokeFailure(`dist/mcp-server.js wrote a non-JSON line to stdout: ${JSON.stringify(line)}`);
      for (const waiter of pending.values()) waiter.reject(malformed);
      pending.clear();
      return;
    }
    pending.get(message.id)?.resolve(message);
    pending.delete(message.id);
  });

  const send = (message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const request = (message) => {
    const response = new Promise((resolve, reject) => pending.set(message.id, { resolve, reject }));
    const exitedEarly = exited.then((exit) => {
      fail(`dist/mcp-server.js exited (${describeExit(exit)}) before answering ${message.method}`, {
        stderr: stderr(),
      });
    });
    send(message);
    return withTimeout(Promise.race([response, exitedEarly]), STEP_TIMEOUT_MS, `${message.method} response`, () => ({
      stderr: stderr(),
    }));
  };

  try {
    const response = await request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: `${SERVER_NAME}-smoke-test`, version },
      },
    });
    if (response.error) {
      fail(`initialize returned a JSON-RPC error: ${JSON.stringify(response.error)}`, { stderr: stderr() });
    }
    const serverInfo = response.result?.serverInfo;
    if (serverInfo?.name !== SERVER_NAME) {
      fail(`initialize result has no serverInfo.name ${JSON.stringify(SERVER_NAME)}`, {
        result: JSON.stringify(response.result),
        stderr: stderr(),
      });
    }
    // serverInfo.version comes from the __SYNC_WORKTREES_VERSION__ define.
    if (serverInfo.version !== version) {
      fail(
        `initialize reported server version ${JSON.stringify(serverInfo.version)}, expected ${JSON.stringify(version)}`,
      );
    }
    if (response.result.protocolVersion !== MCP_PROTOCOL_VERSION) {
      fail(
        `initialize negotiated protocol ${JSON.stringify(response.result.protocolVersion)}, expected ${JSON.stringify(MCP_PROTOCOL_VERSION)}`,
      );
    }
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    // Tool inputs are strict objects, so an argument key no tool declares is
    // refused by name. The vitest suite asserts this against a bundle it builds
    // from src/ at test time, which leaves the shipped artifact unproven: only
    // this check runs the tools/call path through dist/mcp-server.js. Were the
    // schemas loose again, `repo_name` would be stripped and the call would
    // reach the handler, failing on the empty sandbox instead — an error either
    // way, so the key name in the text is what separates the two.
    const toolCall = await request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "create_worktree", arguments: { branchName: "smoke", repo_name: "nope" } },
    });
    const toolText = toolCall.result?.content?.[0]?.text ?? "";
    if (toolCall.error || toolCall.result?.isError !== true || !toolText.includes("repo_name")) {
      fail("tools/call with an undeclared argument key must fail naming the key (strict tool input schemas)", {
        response: JSON.stringify(toolCall),
        stderr: stderr(),
      });
    }

    // A stdio server must shut down when the client closes its end.
    child.stdin.end();
    const exit = await withTimeout(exited, STEP_TIMEOUT_MS, "dist/mcp-server.js exit after stdin closed", () => ({
      stderr: stderr(),
    }));
    if (exit.code !== 0) {
      fail(`dist/mcp-server.js did not exit cleanly after stdin closed (${describeExit(exit)})`, { stderr: stderr() });
    }
    if (malformed) throw malformed;
  } finally {
    lines.close();
    killIfRunning(child);
  }
}

async function checkTarballContents() {
  // `npm pack --dry-run` applies package.json `files` exactly as publish does.
  const result = await run("npm", ["pack", "--dry-run", "--json"], { cwd: repoRoot, env: process.env });
  if (result.code !== 0) {
    fail(`npm pack --dry-run failed (${describeExit(result)})`, { stdout: result.stdout, stderr: result.stderr });
  }
  let files;
  let unpackedSize;
  try {
    [{ files, unpackedSize }] = JSON.parse(result.stdout);
  } catch (error) {
    fail(`could not parse npm pack --dry-run --json output: ${error.message}`, { stdout: result.stdout });
  }
  if (!Array.isArray(files)) {
    fail("npm pack --dry-run --json output has no files array", { stdout: result.stdout });
  }
  if (!Number.isInteger(unpackedSize)) {
    fail("npm pack --dry-run --json output has no unpackedSize", { stdout: result.stdout });
  }
  const shipped = files.map((file) => file.path);

  const missing = REQUIRED_TARBALL_PATHS.filter((file) => !shipped.includes(file));
  if (missing.length > 0) {
    fail(`npm tarball is missing package entry points: ${missing.join(", ")}`, { "shipped files": shipped.join("\n") });
  }
  const leaked = shipped.filter((file) => FORBIDDEN_TARBALL_PREFIXES.some((prefix) => file.startsWith(prefix)));
  if (leaked.length > 0) {
    fail(`npm tarball ships files outside bin/ and dist/: ${leaked.join(", ")}`);
  }
  const maps = shipped.filter((file) => FORBIDDEN_TARBALL_SUFFIXES.some((suffix) => file.endsWith(suffix)));
  if (maps.length > 0) {
    fail(
      `npm tarball ships source maps (re-enabled in the build config, or stale dist/ output: delete dist/ and rebuild): ${maps.join(", ")}`,
    );
  }
  if (shipped.length > MAX_TARBALL_FILES) {
    fail(`npm tarball has ${shipped.length} files, above the MAX_TARBALL_FILES ceiling of ${MAX_TARBALL_FILES}`, {
      "shipped files": shipped.join("\n"),
    });
  }
  if (unpackedSize > MAX_TARBALL_UNPACKED_BYTES) {
    const largest = [...files]
      .sort((a, b) => b.size - a.size)
      .slice(0, 10)
      .map((file) => `${String(file.size).padStart(9)} ${file.path}`);
    fail(
      `npm tarball unpacks to ${unpackedSize} bytes, above the MAX_TARBALL_UNPACKED_BYTES ceiling of ${MAX_TARBALL_UNPACKED_BYTES}`,
      { "largest files": largest.join("\n") },
    );
  }
  return `${shipped.length} files, ${unpackedSize} bytes unpacked`;
}

async function createSandbox() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sync-worktrees-smoke-"));
  return {
    cwd: dir,
    env: {
      ...process.env,
      HOME: dir,
      XDG_STATE_HOME: path.join(dir, "state"),
      XDG_CONFIG_HOME: path.join(dir, "config"),
    },
  };
}

async function main() {
  for (const bundle of [CLI_BUNDLE, MCP_BUNDLE]) {
    try {
      await access(bundle);
    } catch {
      console.error(`Missing ${path.relative(repoRoot, bundle)}: run \`pnpm build\` before \`pnpm smoke\`.`);
      return 1;
    }
  }

  const checks = [
    ["bin/sync-worktrees.js --version prints the package version", checkCliVersion],
    ["dist/mcp-server.js handshakes over stdio and refuses an undeclared tool argument", checkMcpHandshake],
    ["npm pack ships the entry points, no source maps, and stays under the size ceilings", checkTarballContents],
  ];

  const sandbox = await createSandbox();
  let failures = 0;
  try {
    for (const [name, check] of checks) {
      const startedAt = performance.now();
      try {
        // A check may return a short note (measurements worth seeing in CI logs).
        const note = await check(sandbox);
        const suffix = typeof note === "string" ? ` [${note}]` : "";
        console.log(`ok   ${name}${suffix} (${Math.round(performance.now() - startedAt)} ms)`);
      } catch (error) {
        failures += 1;
        const reason = error instanceof SmokeFailure ? error.message : (error.stack ?? String(error));
        console.error(`FAIL ${name}\n${indent(reason)}`);
      }
    }
  } finally {
    await rm(sandbox.cwd, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\nSmoke test failed: ${failures} of ${checks.length} checks did not pass.`);
    return 1;
  }
  console.log(`\nSmoke test passed: ${checks.length} checks.`);
  return 0;
}

process.exitCode = await main();
