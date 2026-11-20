#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const { version } = packageJson;

const CLI_BIN = path.join(repoRoot, "bin", "sync-worktrees.js");
const MCP_BIN = path.join(repoRoot, "bin", "sync-worktrees-mcp.js");
const CLI_BUNDLE = path.join(repoRoot, "dist", "index.js");
const MCP_BUNDLE = path.join(repoRoot, "dist", "mcp-server.js");
const TSC = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
const SERVER_NAME = "sync-worktrees";
const SHEBANG = "#!/usr/bin/env node";
const MCP_PROTOCOL_VERSION = "2025-11-25";
function exportTargets(value) {
  if (typeof value === "string") return [value.replace(/^\.\//, "")];
  return Object.values(value ?? {}).flatMap(exportTargets);
}
const REQUIRED_TARBALL_PATHS = [
  ...new Set([
    packageJson.main,
    packageJson.types,
    ...Object.values(packageJson.bin),
    ...exportTargets(packageJson.exports).filter((file) => file !== "package.json"),
  ]),
];
const FORBIDDEN_TARBALL_PREFIXES = ["src/", "scripts/", ".pnpmfile.cjs"];
const FORBIDDEN_TARBALL_SUFFIXES = [".map"];
const MAX_TARBALL_FILES = 40;
const MAX_TARBALL_UNPACKED_BYTES = 1_150_000;
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

async function checkBinShebangs() {
  for (const bin of Object.values(packageJson.bin)) {
    const firstLine = (await readFile(path.join(repoRoot, bin), "utf8")).split("\n", 1)[0];
    if (firstLine !== SHEBANG) {
      fail(`${bin} must start with "${SHEBANG}" (npm links it as an executable)`, { "first line": firstLine });
    }
  }
}

async function checkMcpHandshake(sandbox) {
  await checkBinShebangs();

  const child = spawn(process.execPath, [MCP_BIN], { ...sandbox, stdio: ["pipe", "pipe", "pipe"] });
  const stderr = collect(child.stderr);
  child.stdin.on("error", () => {});
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  exited.catch(() => {});

  const pending = new Map();
  let malformed = null;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      malformed ??= new SmokeFailure(
        `bin/sync-worktrees-mcp.js wrote a non-JSON line to stdout: ${JSON.stringify(line)}`,
      );
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
      fail(`bin/sync-worktrees-mcp.js exited (${describeExit(exit)}) before answering ${message.method}`, {
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

    child.stdin.end();
    const exit = await withTimeout(
      exited,
      STEP_TIMEOUT_MS,
      "bin/sync-worktrees-mcp.js exit after stdin closed",
      () => ({
        stderr: stderr(),
      }),
    );
    if (exit.code !== 0) {
      fail(`bin/sync-worktrees-mcp.js did not exit cleanly after stdin closed (${describeExit(exit)})`, {
        stderr: stderr(),
      });
    }
    if (malformed) throw malformed;
  } finally {
    lines.close();
    killIfRunning(child);
  }
}

async function checkTarballContents() {
  const result = await run("npm", ["pack", "--dry-run", "--json"], { cwd: repoRoot, env: process.env });
  if (result.code !== 0) {
    fail(`npm pack --dry-run failed (${describeExit(result)})`, { stdout: result.stdout, stderr: result.stderr });
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    fail(`could not parse npm pack --dry-run --json output: ${error.message}`, { stdout: result.stdout });
  }
  const [packed] = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {});
  if (packed === null || typeof packed !== "object") {
    fail("npm pack --dry-run --json output describes no packed package", { stdout: result.stdout });
  }
  const { files, unpackedSize } = packed;
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
  await checkNoStaleChunks(shipped);
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

async function checkNoStaleChunks(shipped) {
  const entries = ["dist/index.js", "dist/mcp-server.js"];
  const imported = new Set(entries);
  for (const entry of entries) {
    const source = await readFile(path.join(repoRoot, entry), "utf8");
    for (const [, chunk] of source.matchAll(/from\s*"\.\/(chunk-[^"]+\.js)"/g)) imported.add(`dist/${chunk}`);
  }
  const stale = shipped.filter((file) => /^dist\/[^/]+\.js$/.test(file) && !imported.has(file));
  if (stale.length > 0) {
    fail(
      `npm tarball ships JavaScript no entry imports (stale build output: delete dist/ and rebuild): ${stale.join(", ")}`,
    );
  }
}

async function checkPublicTypes(sandbox) {
  const project = path.join(sandbox.cwd, "types-consumer");
  await mkdir(path.join(project, "node_modules"), { recursive: true });
  await symlink(repoRoot, path.join(project, "node_modules", SERVER_NAME), "dir");
  const configFor = (key) => `/** @satisfies {import("sync-worktrees").SyncWorktreesConfig} */
export default {
  repositories: [{ name: "app", repoUrl: "https://example.com/app.git", worktreeDir: "./app", ${key}: "0 * * * *" }],
};
`;
  await writeFile(path.join(project, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(project, "good.config.js"), configFor("cronSchedule"));
  await writeFile(path.join(project, "bad.config.js"), configFor("cronSchedul"));
  await writeFile(
    path.join(project, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        strict: true,
        noEmit: true,
        allowJs: true,
        checkJs: true,
        skipLibCheck: false,
        types: [],
      },
      files: ["good.config.js", "bad.config.js"],
    }),
  );

  const result = await run(process.execPath, [TSC, "-p", project, "--pretty", "false"], { ...sandbox, cwd: project });
  const errors = result.stdout.split("\n").filter((line) => line.includes("error TS"));
  const unexpected = errors.filter((line) => !/(^|[\\/])bad\.config\.js\(/.test(line));
  if (unexpected.length > 0 || result.timedOut) {
    fail(`the published types do not type-check a documented config (${describeExit(result)})`, {
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  if (!errors.some((line) => line.includes("cronSchedul'"))) {
    fail("the published types accepted a config with a misspelled key (did they resolve to `any`?)", {
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
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
    ["bin/sync-worktrees-mcp.js handshakes over stdio and refuses an undeclared tool argument", checkMcpHandshake],
    ["the exported types check a documented config under NodeNext resolution", checkPublicTypes],
    [
      "npm pack ships the entry points, no source maps or stale chunks, and stays under the size ceilings",
      checkTarballContents,
    ],
  ];

  const sandbox = await createSandbox();
  let failures = 0;
  try {
    for (const [name, check] of checks) {
      const startedAt = performance.now();
      try {
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
