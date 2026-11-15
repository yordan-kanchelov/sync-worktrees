import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DoctorCheck } from "../../cli/doctor";

// A repository name is used as a path segment (lock and audit-log files).
// Names reserved only on Windows must sync; names that cannot become a
// segment must be refused by validation, not crash later.
describe("repository name as a path segment (E2E)", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  let tempDir: string;
  let origin: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-name-segment-")));
    origin = path.join(tempDir, "origin.git");
    const seed = path.join(tempDir, "seed");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["init", "-q", "-b", "main", seed]);
    await fs.writeFile(path.join(seed, "README.md"), "hello\n");
    const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
    execFileSync("git", ["-C", seed, "add", "README.md"]);
    execFileSync("git", ["-C", seed, ...identity, "commit", "-q", "-m", "init"]);
    execFileSync("git", ["-C", seed, "push", "-q", origin, "main"]);
    configPath = path.join(tempDir, "sync-worktrees.config.mjs");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(name: string): Promise<void> {
    await fs.writeFile(
      configPath,
      `export default { repositories: [
  { name: ${JSON.stringify(name)}, repoUrl: ${JSON.stringify(`file://${origin}`)}, worktreeDir: ${JSON.stringify(path.join(tempDir, "wt"))} },
] };\n`,
    );
  }

  function run(args: string[]): { status: number | null; stdout: string; output: string } {
    const result = spawnSync(process.execPath, [binPath, ...args], {
      cwd: tempDir,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tempDir,
        NO_COLOR: "1",
        FORCE_COLOR: undefined,
        SYNC_WORKTREES_UNIT_TEST: undefined,
      },
      input: "",
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout, output: result.stdout + result.stderr };
  }

  it("syncs a repository named 'aux'", async () => {
    await writeConfig("aux");

    const result = run(["--config", configPath, "--runOnce"]);

    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain("1 synced");
  }, 60_000);

  it("doctor --json reports a name that cannot become a path segment as a failed check", async () => {
    await writeConfig("..");

    const result = run(["doctor", "--config", configPath, "--json"]);

    expect(result.status, result.output).toBe(1);
    const checks = JSON.parse(result.stdout) as DoctorCheck[];
    const config = checks.find((item) => item.check === "config");
    expect(config?.status).toBe("fail");
    expect(config?.message).toContain("repositories[0].name");
  }, 60_000);
});
