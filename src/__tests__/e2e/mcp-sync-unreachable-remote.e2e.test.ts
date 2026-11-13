import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChildProcessWithoutNullStreams } from "child_process";

// The example config ships `retry.maxAttempts: "unlimited"`. Over MCP a sync
// against an unreachable remote must still answer, must not keep holding the
// repository lock afterwards, and closing stdin must end the server.
describe("MCP sync with an unreachable remote and unlimited retries", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees-mcp.js");
  let tempDir: string;
  let bareRepo: string;
  let worktreeDir: string;
  let child: ChildProcessWithoutNullStreams | undefined;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-mcp-unreachable-")));
    bareRepo = path.join(tempDir, "origin.git");
    worktreeDir = path.join(tempDir, "worktrees");

    await simpleGit().init(["--bare", bareRepo]);
    const initDir = path.join(tempDir, "init");
    await fs.mkdir(initDir);
    const initGit = simpleGit(initDir);
    await initGit.init();
    await initGit.addConfig("user.name", "Test User");
    await initGit.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(initDir, "README.md"), "# Test");
    await initGit.add(".");
    await initGit.commit("Initial commit");
    await initGit.branch(["-M", "main"]);
    await initGit.addRemote("origin", bareRepo);
    await initGit.push("origin", "main");
    await simpleGit(bareRepo).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await fs.rm(initDir, { recursive: true });
  });

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    child = undefined;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(retry: string): Promise<void> {
    await fs.writeFile(
      path.join(tempDir, "sync-worktrees.config.js"),
      `export default {
  retry: ${retry},
  repositories: [
    {
      name: "test-repo",
      repoUrl: "file://${bareRepo}",
      worktreeDir: "${worktreeDir}",
      bareRepoDir: "${path.join(tempDir, ".bare")}",
    }
  ]
};
`,
    );
  }

  function startServer() {
    const proc = spawn(process.execPath, [binPath], {
      cwd: tempDir,
      env: { ...process.env, SYNC_WORKTREES_LOCK_DIR: path.join(tempDir, "locks") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = proc;
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
    const lines = readline.createInterface({ input: proc.stdout });
    const pending = new Map<number, (message: any) => void>();
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
    });

    let nextId = 1;
    const request = (method: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} did not answer within ${timeoutMs}ms. stderr: ${stderr}`));
        }, timeoutMs);
        pending.set(id, (message) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(message);
        });
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    };
    const callTool = (name: string, args: Record<string, unknown>, timeoutMs: number) =>
      request("tools/call", { name, arguments: args }, timeoutMs).then((message) => message.result);
    const handshake = async (): Promise<void> => {
      await request(
        "initialize",
        { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
        15_000,
      );
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    };
    const exitsWithin = (ms: number) =>
      Promise.race([exited, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))]);

    return { proc, callTool, handshake, exitsWithin, stderr: () => stderr };
  }

  it("answers sync with isError, releases the lock and exits when stdin closes", async () => {
    await writeConfig(`{ maxAttempts: "unlimited", initialDelayMs: 200, maxDelayMs: 1000 }`);
    const server = startServer();
    await server.handshake();

    const init = await server.callTool("initialize", {}, 30_000);
    expect(init.isError, JSON.stringify(init)).not.toBe(true);

    await fs.rm(bareRepo, { recursive: true, force: true });

    const sync = await server.callTool("sync", {}, 30_000);
    expect(sync.isError, JSON.stringify(sync)).toBe(true);

    const update = await server.callTool("update_worktree", { path: path.join(worktreeDir, "main") }, 30_000);
    expect(JSON.stringify(update)).not.toContain("SYNC_IN_PROGRESS");

    server.proc.stdin.end();
    expect(await server.exitsWithin(10_000), server.stderr()).not.toBe("timeout");
  }, 90_000);

  it("exits when stdin closes while a sync is waiting out a retry backoff", async () => {
    await writeConfig(`{ maxAttempts: "unlimited", initialDelayMs: 120000, maxDelayMs: 120000 }`);
    const server = startServer();
    await server.handshake();

    const init = await server.callTool("initialize", {}, 30_000);
    expect(init.isError, JSON.stringify(init)).not.toBe(true);

    await fs.rm(bareRepo, { recursive: true, force: true });

    void server.callTool("sync", {}, 60_000).catch(() => {});
    const deadline = Date.now() + 20_000;
    while (!server.stderr().includes("Sync attempt 1 failed") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(server.stderr()).toContain("Sync attempt 1 failed");

    server.proc.stdin.end();
    expect(await server.exitsWithin(10_000), server.stderr()).not.toBe("timeout");
  }, 90_000);
});
