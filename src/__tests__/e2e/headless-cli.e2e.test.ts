import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// What the built bin does with no terminal attached — systemd, docker, CI, or
// `sync-worktrees < /dev/null`. A spawned child's stdio here is pipes, never a
// TTY, which is exactly that situation.
describe("CLI without a terminal", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-headless-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [binPath, ...args], {
      cwd: tempDir,
      encoding: "utf-8",
      env: { ...process.env, HOME: tempDir, SYNC_WORKTREES_UNIT_TEST: undefined },
      input: "",
      timeout: 30000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  // Ink used to print "Raw mode is not supported" with a stack trace, and the
  // process exited 0 having synced nothing.
  it("refuses to start the dashboard, exits non-zero and points at --run-once", async () => {
    const configPath = path.join(tempDir, "sync-worktrees.config.mjs");
    await fs.writeFile(
      configPath,
      `export default { repositories: [{ name: "app", repoUrl: "https://example.invalid/app.git", worktreeDir: ${JSON.stringify(path.join(tempDir, "wt"))} }] };\n`,
    );

    const result = run(["--config", configPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("needs a terminal");
    expect(result.stderr).toContain("--run-once");
    expect(result.stderr).not.toContain("Raw mode");
  });

  // The prompts can never be answered: the process used to sit there and then
  // die with Node's "unsettled top-level await" warning.
  it("refuses to run the init wizard and writes nothing", async () => {
    const configPath = path.join(tempDir, "sync-worktrees.config.js");

    const result = run(["init", "--config", configPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("needs a terminal");
    expect(result.stderr).not.toContain("unsettled top-level await");
    await expect(fs.access(configPath)).rejects.toThrow();
  });
});
