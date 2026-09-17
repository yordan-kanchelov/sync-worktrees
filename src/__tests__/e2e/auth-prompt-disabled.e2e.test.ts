import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AddressInfo } from "net";

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

// git prompts for credentials on /dev/tty whenever a terminal is attached,
// regardless of stdio pipes. Before every git subprocess ran with
// GIT_TERMINAL_PROMPT=0, a remote without a usable credential helper made the
// clone/fetch print "Username for ...:" into the TUI and wait until the 300 s
// inactivity timeout killed it. Now git fails within a second with its own
// "terminal prompts disabled" message and the run reports what to configure.
describe("CLI fails fast when the remote needs credentials git cannot obtain", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  let tempDir: string;
  let home: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let configPath: string;
  let server: http.Server;
  let remoteUrl: string;
  const requests: string[] = [];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-auth-prompt-"));
    home = path.join(tempDir, "home");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    configPath = path.join(tempDir, "sync-worktrees.config.js");
    await fs.mkdir(home, { recursive: true });

    // Every request needs credentials, like a private HTTPS remote.
    requests.length = 0;
    server = http.createServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="sync-worktrees-e2e"' });
      res.end("authentication required");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/private/app.git`;

    await fs.writeFile(
      configPath,
      `export default {
  repositories: [
    {
      name: "app",
      repoUrl: "${remoteUrl}",
      worktreeDir: "${worktreeDir}",
      bareRepoDir: "${bareRepoDir}",
    }
  ]
};
`,
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // No credential source may answer for the CLI: a fresh HOME (no global
  // helper, no ~/.netrc), no system config, no askpass, no GIT_CONFIG_* and no
  // inherited GIT_TERMINAL_PROMPT — the CLI itself must disable the prompt.
  // Asynchronous spawn, not spawnSync: the 401 server lives in this process
  // and has to stay responsive while git talks to it.
  function runCli(): Promise<CliRun> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
    }
    delete env.GIT_TERMINAL_PROMPT;
    delete env.GIT_ASKPASS;
    delete env.SSH_ASKPASS;
    delete env.GIT_CONFIG_GLOBAL;
    Object.assign(env, { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1" });

    return new Promise((resolve, reject) => {
      const started = Date.now();
      let stdout = "";
      let stderr = "";
      const child = spawn(process.execPath, [binPath, "--config", configPath, "--runOnce"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      // Backstop only: without the fix and with a terminal attached, git would
      // wait on its credential prompt until the inactivity timeout.
      const killer = setTimeout(() => child.kill("SIGKILL"), 45_000);
      child.on("error", (error) => {
        clearTimeout(killer);
        reject(error);
      });
      child.on("close", (status) => {
        clearTimeout(killer);
        resolve({ status, stdout, stderr, elapsedMs: Date.now() - started });
      });
    });
  }

  it("reports git's 'terminal prompts disabled' failure with the credential hint within seconds", async () => {
    const run = await runCli();
    const output = run.stdout + run.stderr;

    expect(run.status, output).toBe(1);
    expect(run.elapsedMs, output).toBeLessThan(10_000);
    expect(requests).toContain("/private/app.git/info/refs?service=git-upload-pack");

    expect(run.stderr).toContain("Failed to initialize repository");
    expect(run.stderr).toMatch(/could not read Username for 'http:\/\/127\.0\.0\.1:\d+': terminal prompts disabled/);
    expect(run.stderr).toContain("Hint: sync-worktrees runs git non-interactively (GIT_TERMINAL_PROMPT=0)");
    expect(run.stderr).toContain("credential helper");
    expect(run.stdout).toContain("0 synced");
    expect(run.stdout).toContain("1 failed");
    // Nothing was retried and no bare repository was left behind.
    expect(output).not.toContain("Retrying synchronization");
    expect(output).not.toContain("Synchronization finished");
  }, 60_000);
});
