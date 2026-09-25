import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DoctorCheck } from "../../cli/doctor";

// `sync-worktrees doctor` through the built bin, against a real file:// remote:
// what a user sees before their first sync.
describe("sync-worktrees doctor", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-doctor-")));
    const origin = path.join(tempDir, "origin.git");
    const seed = path.join(tempDir, "seed");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["init", "-q", "-b", "main", seed]);
    await fs.writeFile(path.join(seed, "README.md"), "hello\n");
    const identity = ["-c", "user.name=Doctor", "-c", "user.email=doctor@example.com"];
    execFileSync("git", ["-C", seed, "add", "README.md"]);
    execFileSync("git", ["-C", seed, ...identity, "commit", "-q", "-m", "init"]);
    execFileSync("git", ["-C", seed, "push", "-q", origin, "main"]);

    configPath = path.join(tempDir, "sync-worktrees.config.mjs");
    await fs.writeFile(
      configPath,
      `export default { repositories: [
  { name: "app", repoUrl: ${JSON.stringify(`file://${origin}`)}, worktreeDir: ${JSON.stringify(path.join(tempDir, "wt", "app"))} },
  { name: "gone", repoUrl: ${JSON.stringify(`file://${path.join(tempDir, "missing.git")}`)}, worktreeDir: ${JSON.stringify(path.join(tempDir, "wt", "gone"))} },
] };\n`,
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [binPath, "doctor", ...args], {
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
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("passes a reachable file:// remote with writable directories and exits 0", () => {
    const result = run(["--filter", "app", "--json"]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const checks = JSON.parse(result.stdout) as DoctorCheck[];
    const failures = checks.filter((item) => item.status === "fail");
    expect(failures).toEqual([]);
    expect(checks.find((item) => item.check === "config")?.message).toContain(configPath);
    const remote = checks.find((item) => item.check === "remote" && item.repository === "app");
    expect(remote?.status).toBe("pass");
    expect(remote?.message).toContain("(1 branch)");
    for (const id of ["worktree-dir", "bare-repo-dir", "disk-space", "lock-dir", "state-dir"]) {
      expect(checks.find((item) => item.check === id && item.repository === "app")?.status, id).not.toBe("fail");
    }
  });

  it("fails an unreachable remote, prints only problems under --quiet, and exits 1", () => {
    const result = run(["--quiet"]);

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("PASS");
    expect(result.stdout).toContain("FAIL  gone › remote:");
    expect(result.stdout).toContain("💡");
    expect(result.stdout).not.toContain("\u001b[");
    expect(result.stdout.trimEnd().split("\n").at(-1)).toMatch(/^🩺 \d+ passed, \d+ warnings?, 1 failed$/);
  });

  it("finds the config in the current directory and fails without one", async () => {
    expect(run([]).stdout).toContain(`config: ${configPath} is valid (2 repositories)`);

    await fs.rm(configPath);
    const missing = run([]);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("FAIL  config: No config file found");
  });
});
