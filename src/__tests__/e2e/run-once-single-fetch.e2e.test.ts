import { execSync, spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface CliRun {
  status: number | null;
  output: string;
}

// `--run-once` used to call initialize() and then sync(): initialize fetched in
// the bare repository outside the retry policy, then the sync fetched again.
// One fetch per run now, and an unreachable remote gets every retry attempt.
describe("run-once fetch count and retry (E2E)", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  const realGit = execSync("command -v git", { shell: "/bin/sh" }).toString().trim();
  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let configPath: string;
  let shimDir: string;
  let shimLog: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-single-fetch-")));
    remote = path.join(tempDir, "remote", "app.git");
    worktreeDir = path.join(tempDir, "worktrees");
    configPath = path.join(tempDir, "sync-worktrees.config.js");
    shimDir = path.join(tempDir, "shim");
    shimLog = path.join(tempDir, "spawns.log");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);
    const seedDir = path.join(tempDir, "seed");
    await fs.mkdir(seedDir);
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(seedDir, "README.md"), "# app");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await fs.rm(seedDir, { recursive: true });

    await fs.mkdir(shimDir, { recursive: true });
    await fs.writeFile(
      path.join(shimDir, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${shimLog}'\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(
    extra = `\n      bareRepoDir: ${JSON.stringify(path.join(tempDir, ".bare", "app"))},`,
  ): Promise<void> {
    await fs.writeFile(
      configPath,
      `export default {
  retry: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 20 },
  repositories: [
    {
      name: "app",
      repoUrl: ${JSON.stringify(`file://${remote}`)},
      worktreeDir: ${JSON.stringify(worktreeDir)},
      maintenance: { enabled: false },${extra}
    }
  ]
};
`,
    );
  }

  function runCli(): CliRun {
    const result = spawnSync(process.execPath, [binPath, "--config", configPath, "--runOnce"], {
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...process.env,
        PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SYNC_WORKTREES_LOCK_DIR: path.join(tempDir, "locks"),
      },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  async function fetchSpawns(): Promise<string[]> {
    const log = await fs.readFile(shimLog, "utf-8").catch(() => "");
    return log.split("\n").filter((line) => /(^|\s)fetch(\s|$)/.test(line));
  }

  it("fetches exactly once on a steady-state run", async () => {
    await writeConfig();
    const first = runCli();
    expect(first.status, first.output).toBe(0);

    await fs.writeFile(shimLog, "");
    const second = runCli();
    expect(second.status, second.output).toBe(0);
    expect(second.output).toContain("1 synced");
    expect(await fetchSpawns()).toHaveLength(1);
  }, 60000);

  it("retries an unreachable remote maxAttempts times before failing", async () => {
    await writeConfig();
    expect(runCli().status).toBe(0);

    await fs.rename(remote, `${remote}.gone`);
    await fs.writeFile(shimLog, "");
    const run = runCli();

    expect(run.status, run.output).toBe(1);
    expect(await fetchSpawns()).toHaveLength(3);
    expect(run.output).toContain("Sync attempt 1 failed");
    expect(run.output).toContain("Sync attempt 2 failed");
    expect(run.output).not.toContain("Sync attempt 3 failed");
  }, 60000);

  it("retries the initial clone of an unreachable remote", async () => {
    await writeConfig();
    await fs.rename(remote, `${remote}.gone`);
    await fs.writeFile(shimLog, "");
    const run = runCli();

    expect(run.status, run.output).toBe(1);
    const log = await fs.readFile(shimLog, "utf-8");
    expect(log.split("\n").filter((line) => /(^|\s)clone(\s|$)/.test(line))).toHaveLength(3);
    expect(run.output).toContain("Failed to initialize repository 'app'");
  }, 60000);

  it("warns once about a clone-mode branch mismatch", async () => {
    await writeConfig(`\n      mode: "clone",\n      branch: "main",`);
    expect(runCli().status).toBe(0);
    execSync(`git -C "${worktreeDir}" checkout -q -b sidebranch`);

    const run = runCli();
    expect(run.status, run.output).toBe(0);
    const warnings = run.output.split("\n").filter((line) => line.startsWith("[app]") && line.includes("'sidebranch'"));
    expect(warnings, run.output).toHaveLength(1);
    expect(run.output).toContain("1 with clone-mode skips");
  }, 60000);
});
