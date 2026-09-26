import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

// ssh reads a key passphrase or an unknown-host confirmation from /dev/tty
// itself, so GIT_TERMINAL_PROMPT=0 never reached it: a passphrase-protected key
// without an agent blocked every clone and fetch until the 300 s inactivity
// timeout. An ssh remote's git now runs with SSH_ASKPASS_REQUIRE=force and a
// failing askpass, so ssh gives up at once — without the tool touching the ssh
// command the user configured.
//
// The ssh here is a stand-in, reached through the user's own GIT_SSH_COMMAND:
// at the prompt it does what OpenSSH 8.4+ does — asks the askpass program when
// SSH_ASKPASS_REQUIRE=force, and otherwise waits on the terminal.
describe.skipIf(process.platform === "win32")("CLI fails fast when ssh would prompt", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  let tempDir: string;
  let fakeSshPath: string;
  let invokedMarker: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-ssh-prompt-"));
    fakeSshPath = path.join(tempDir, "fake-ssh.sh");
    invokedMarker = path.join(tempDir, "fake-ssh-invoked");
    configPath = path.join(tempDir, "sync-worktrees.config.js");

    await fs.writeFile(
      fakeSshPath,
      `#!/bin/sh
echo "$SSH_ASKPASS_REQUIRE" > "${invokedMarker}"
if [ "$SSH_ASKPASS_REQUIRE" = "force" ] && [ -n "$SSH_ASKPASS" ]; then
  "$SSH_ASKPASS" "Enter passphrase for key '/home/user/.ssh/id_ed25519': " >/dev/null 2>&1
  echo "git@git.example.invalid: Permission denied (publickey)." >&2
  exit 255
fi
sleep 600
`,
      { mode: 0o755 },
    );

    await fs.writeFile(
      configPath,
      `export default {
  repositories: [
    {
      name: "app",
      repoUrl: "git@git.example.invalid:org/app.git",
      worktreeDir: "${path.join(tempDir, "worktrees")}",
      bareRepoDir: "${path.join(tempDir, ".bare", "app")}",
    }
  ]
};
`,
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function runCli(): Promise<CliRun> {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_SSH_COMMAND: fakeSshPath };
    delete env.GIT_TERMINAL_PROMPT;
    delete env.SSH_ASKPASS;
    delete env.SSH_ASKPASS_REQUIRE;
    delete env.GIT_SSH;

    return new Promise((resolve, reject) => {
      const started = Date.now();
      let stdout = "";
      let stderr = "";
      const child = spawn(process.execPath, [binPath, "--config", configPath, "--run-once"], {
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
      // Backstop only: without the fix the stand-in waits on its "terminal"
      // until the inactivity timeout.
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

  it("reports ssh's refusal with the ssh-agent hint within seconds, through the user's own ssh command", async () => {
    const run = await runCli();
    const output = run.stdout + run.stderr;

    expect(run.status, output).toBe(1);
    expect(run.elapsedMs, output).toBeLessThan(15_000);
    // The configured GIT_SSH_COMMAND is what ran, with prompts routed away from the terminal.
    expect((await fs.readFile(invokedMarker, "utf8")).trim()).toBe("force");

    expect(run.stderr).toContain("Failed to initialize repository");
    expect(run.stderr).toContain("Permission denied (publickey)");
    expect(run.stderr).toContain("Hint: sync-worktrees runs git non-interactively and cannot answer an ssh prompt");
    expect(output).not.toContain("Retrying synchronization");
  }, 60_000);
});
