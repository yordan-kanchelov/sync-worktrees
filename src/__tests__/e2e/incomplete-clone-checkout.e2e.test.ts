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

describe("CLI refuses to adopt a clone whose checkout never finished", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  const POINTER = "version https://git-lfs.github.com/spec/v1\noid sha256:d0d0\nsize 12\n";

  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let configPath: string;
  let gitConfigPath: string;
  let smudgeScript: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-incomplete-clone-")));
    remote = path.join(tempDir, "remote", "app.git");
    worktreeDir = path.join(tempDir, "checkout");
    configPath = path.join(tempDir, "sync-worktrees.config.js");
    gitConfigPath = path.join(tempDir, "lfs.gitconfig");
    smudgeScript = path.join(tempDir, "fake-lfs-smudge.sh");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

    const seedDir = path.join(tempDir, "seed");
    await fs.mkdir(seedDir);
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(seedDir, ".gitattributes"), "*.bin filter=lfs\n");
    await fs.writeFile(path.join(seedDir, "README.md"), "# app\n");
    await fs.writeFile(path.join(seedDir, "big.bin"), POINTER);
    await fs.mkdir(path.join(seedDir, "pkg"));
    await fs.writeFile(path.join(seedDir, "pkg", "big.bin"), POINTER);
    await fs.mkdir(path.join(seedDir, "other"));
    await fs.writeFile(path.join(seedDir, "other", "plain.txt"), "outside the cone\n");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await fs.rm(seedDir, { recursive: true });

    await writeConfig();
  });

  async function writeConfig(extraSettings = ""): Promise<void> {
    await fs.writeFile(
      configPath,
      `export default {
  repositories: [
    {
      name: "app",
      repoUrl: ${JSON.stringify(`file://${remote}`)},
      worktreeDir: ${JSON.stringify(worktreeDir)},
      mode: "clone",
      branch: "main",
      retry: { maxAttempts: 1, initialDelayMs: 0 },${extraSettings}
    }
  ]
};
`,
    );
  }

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function installFakeLfsFilter(honorsSkipEnv: boolean): Promise<void> {
    const body = honorsSkipEnv
      ? '#!/bin/sh\nif [ "$GIT_LFS_SKIP_SMUDGE" = "1" ]; then exec cat; fi\nexit 1\n'
      : "#!/bin/sh\nexit 1\n";
    await fs.writeFile(smudgeScript, body, { mode: 0o755 });
    await fs.writeFile(gitConfigPath, `[filter "lfs"]\n\tsmudge = ${smudgeScript}\n\tclean = cat\n\trequired = true\n`);
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

  function markerPath(): string {
    return path.join(worktreeDir, ".git", ".sync-worktrees-clone-incomplete");
  }

  it("fails both runs and never reports the unfinished clone as a clone-mode skip", async () => {
    await installFakeLfsFilter(false);

    const first = runCli();
    expect(first.status, first.stdout + first.stderr).toBe(1);
    expect(first.stderr).toContain("smudge filter lfs failed");
    expect(first.stdout).toContain("1 failed");

    await expect(fs.access(path.join(worktreeDir, ".git", "HEAD"))).resolves.toBeUndefined();
    const head = await simpleGit(worktreeDir).raw(["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(head.trim()).toBe("main");
    const status = await simpleGit(worktreeDir).raw(["status", "--short"]);
    expect(status.trim()).not.toBe("");
    await expect(fs.readFile(markerPath(), "utf8")).resolves.toContain("smudge filter lfs failed");

    const second = runCli();
    const secondOutput = second.stdout + second.stderr;
    expect(second.status, secondOutput).toBe(1);
    expect(second.stderr).toContain(`previous clone of '${worktreeDir}' did not complete`);
    expect(second.stderr).toContain("smudge filter lfs failed");
    expect(second.stdout).toContain("1 failed");
    expect(second.stdout).not.toContain("with clone-mode skips");
    expect(secondOutput).not.toContain("Clone-mode skips (");
    expect(secondOutput).not.toContain("working tree has local changes");
  }, 60_000);

  it("applies sparse-checkout with LFS skipped when skipLfs is configured", async () => {
    await installFakeLfsFilter(true);
    await writeConfig(`\n      skipLfs: true,\n      sparseCheckout: { include: ["pkg"] },`);

    const first = runCli();
    const firstOutput = first.stdout + first.stderr;
    expect(first.status, firstOutput).toBe(0);
    expect(firstOutput).not.toContain("retrying the checkout with LFS disabled");
    expect(first.stdout).toContain("1 synced");
    await expect(fs.readFile(path.join(worktreeDir, "pkg", "big.bin"), "utf8")).resolves.toBe(POINTER);
    await expect(fs.access(path.join(worktreeDir, "other", "plain.txt"))).rejects.toThrow();
  }, 60_000);

  it("recovers a clone whose sparse-checkout cone holds the failing LFS file", async () => {
    await installFakeLfsFilter(true);
    await writeConfig(`\n      sparseCheckout: { include: ["pkg"] },`);

    const first = runCli();
    const firstOutput = first.stdout + first.stderr;
    expect(first.status, firstOutput).toBe(0);
    expect(first.stdout).toContain("Applying sparse-checkout patterns");
    expect(first.stdout).toContain("1 synced");

    await expect(fs.readFile(path.join(worktreeDir, "pkg", "big.bin"), "utf8")).resolves.toBe(POINTER);
    await expect(fs.access(path.join(worktreeDir, "other", "plain.txt"))).rejects.toThrow();
    const status = await simpleGit(worktreeDir).raw(["status", "--short"]);
    expect(status.trim()).toBe("");
    await expect(fs.access(markerPath())).rejects.toThrow();

    const second = runCli();
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toContain("already up to date with origin/main");
  }, 60_000);

  it("retries the checkout with LFS smudging disabled and keeps syncing afterwards", async () => {
    await installFakeLfsFilter(true);

    const first = runCli();
    const firstOutput = first.stdout + first.stderr;
    expect(first.status, firstOutput).toBe(0);
    expect(first.stdout).toContain("retrying the checkout with LFS disabled");
    expect(firstOutput).toContain("checked out with LFS smudging disabled");
    expect(first.stdout).toContain("1 synced");

    await expect(fs.readFile(path.join(worktreeDir, "big.bin"), "utf8")).resolves.toBe(POINTER);
    const status = await simpleGit(worktreeDir).raw(["status", "--short"]);
    expect(status.trim()).toBe("");
    await expect(fs.access(markerPath())).rejects.toThrow();

    const second = runCli();
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toContain("already up to date with origin/main");
    expect(second.stdout).toMatch(/: 1 synced, 0 failed/);
  }, 60_000);
});
