import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

// `git remote get-url origin` applies `url.<base>.insteadOf`, while the
// stored `remote.origin.url` is the configured repoUrl. Comparing the
// rewritten URL against repoUrl reported a mismatch on every run after the
// first: worktree mode failed, clone mode skipped forever.
describe("origin check with an insteadOf rewrite in the user's git config", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  const repoUrl = "https://git.example.invalid/org/app.git";
  let tempDir: string;
  let worktreeDir: string;
  let configPath: string;
  let gitConfigPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-insteadof-"));
    const remotesDir = path.join(tempDir, "remotes");
    const remote = path.join(remotesDir, "app.git");
    worktreeDir = path.join(tempDir, "worktrees");
    configPath = path.join(tempDir, "sync-worktrees.config.js");
    gitConfigPath = path.join(tempDir, "gitconfig");

    await fs.mkdir(remotesDir, { recursive: true });
    await simpleGit().init(["--bare", remote]);
    const initDir = path.join(tempDir, "init");
    await fs.mkdir(initDir);
    const initGit = simpleGit(initDir);
    await initGit.init();
    await initGit.addConfig("user.name", "Test User");
    await initGit.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(initDir, "README.md"), "# app");
    await initGit.add(".");
    await initGit.commit("Initial commit");
    await initGit.branch(["-M", "main"]);
    await initGit.addRemote("origin", remote);
    await initGit.push("origin", "main");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await fs.rm(initDir, { recursive: true });

    await fs.writeFile(
      gitConfigPath,
      `[url "file://${remotesDir}/"]\n\tinsteadOf = https://git.example.invalid/org/\n`,
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(extra: string): Promise<void> {
    await fs.writeFile(
      configPath,
      `export default {
  repositories: [
    {
      name: "app",
      repoUrl: ${JSON.stringify(repoUrl)},
      worktreeDir: ${JSON.stringify(worktreeDir)},${extra}
    }
  ]
};
`,
    );
  }

  function runCli(): CliRun {
    const result = spawnSync(process.execPath, [binPath, "--config", configPath, "--runOnce"], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function expectSynced(run: CliRun, label: string): void {
    const output = run.stdout + run.stderr;
    expect(run.status, `${label}: ${output}`).toBe(0);
    expect(run.stdout, label).toContain("1 synced");
    expect(output, label).not.toContain("has origin '");
    expect(output, label).not.toContain("Clone-mode skips");
  }

  it("worktree mode syncs on consecutive runs", async () => {
    await writeConfig(`\n      bareRepoDir: ${JSON.stringify(path.join(tempDir, ".bare", "app"))},`);
    expectSynced(runCli(), "first run");
    expectSynced(runCli(), "second run");
  }, 120_000);

  it("clone mode syncs on consecutive runs", async () => {
    await writeConfig(`\n      mode: "clone",\n      branch: "main",`);
    expectSynced(runCli(), "first run");
    expectSynced(runCli(), "second run");
  }, 120_000);
});
