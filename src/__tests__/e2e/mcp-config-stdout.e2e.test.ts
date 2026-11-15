import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChildProcessWithoutNullStreams } from "child_process";

// stdout is the JSON-RPC stream: whatever a config prints while it is
// evaluated (first load on the main thread, reloads in a worker) must not
// reach it.
describe("MCP server with a config that writes to stdout", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees-mcp.js");
  let tempDir: string;
  let child: ChildProcessWithoutNullStreams | undefined;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-mcp-stdout-")));
    await fs.writeFile(
      path.join(tempDir, "sync-worktrees.config.js"),
      `console.log("[dotenv] injecting env from .env");
console.info("info from config");
process.stdout.write("raw write from config\\n");
export default {
  repositories: [
    {
      name: "test-repo",
      repoUrl: "file://${path.join(tempDir, "origin.git")}",
      worktreeDir: "${path.join(tempDir, "worktrees")}",
    }
  ]
};
`,
    );
  });

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    child = undefined;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("keeps every stdout line JSON at startup and across load_config calls", async () => {
    const proc = spawn(process.execPath, [binPath], {
      cwd: tempDir,
      env: { ...process.env, SYNC_WORKTREES_LOCK_DIR: path.join(tempDir, "locks") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = proc;
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const stdoutLines: string[] = [];
    const pending = new Map<number, (message: any) => void>();
    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      stdoutLines.push(line);
      try {
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
      } catch {
        // recorded above; asserted below
      }
    });

    let nextId = 1;
    const request = (method: string, params: Record<string, unknown>): Promise<any> => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} did not answer. stdout: ${stdoutLines.join("\n")}\nstderr: ${stderr}`));
        }, 30_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(message);
        });
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    };

    await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    for (let i = 0; i < 2; i++) {
      const loaded = await request("tools/call", { name: "load_config", arguments: {} });
      expect(loaded.result?.isError, JSON.stringify(loaded)).not.toBe(true);
    }

    for (const line of stdoutLines) {
      expect(() => JSON.parse(line), `non-JSON stdout line: ${line}`).not.toThrow();
    }
    // The config did run, and its output went to stderr instead.
    expect(stderr.match(/\[dotenv\] injecting env from \.env/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(stderr).toContain("raw write from config");
  }, 90_000);
});
