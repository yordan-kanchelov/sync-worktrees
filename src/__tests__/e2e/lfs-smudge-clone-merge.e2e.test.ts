import { execFileSync, spawnSync } from "child_process";
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

describe("clone-mode fast-forward that dies on an LFS smudge", () => {
  const binPath = path.join(__dirname, "../../../bin/sync-worktrees.js");
  const POINTER = "version https://git-lfs.github.com/spec/v1\noid sha256:d0d0\nsize 12\n";

  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let configPath: string;
  let gitConfigPath: string;
  let smudgeScript: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-lfs-merge-")));
    remote = path.join(tempDir, "remote", "app.git");
    seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "checkout");
    configPath = path.join(tempDir, "sync-worktrees.config.js");
    gitConfigPath = path.join(tempDir, "lfs.gitconfig");
    smudgeScript = path.join(tempDir, "fake-lfs-smudge.sh");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

    await fs.mkdir(seedDir);
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(seedDir, "README.md"), "# app\n");
    await fs.writeFile(path.join(seedDir, "README-old.md"), "# retired\n");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

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
      retry: { maxAttempts: 2, initialDelayMs: 0 }
    }
  ]
};
`,
    );
  });

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

  async function repairLfsFilter(): Promise<void> {
    await fs.writeFile(smudgeScript, "#!/bin/sh\nexec cat\n", { mode: 0o755 });
  }

  async function pushLfsCommit(): Promise<string> {
    const seed = simpleGit(seedDir);
    await fs.writeFile(path.join(seedDir, ".gitattributes"), "*.bin filter=lfs\n");
    await fs.writeFile(path.join(seedDir, "0-plain.txt"), "plain\n");
    await fs.symlink("README.md", path.join(seedDir, "0-link.md"));
    await fs.symlink("assets/big.bin", path.join(seedDir, "0-dangling.md"));
    await fs.mkdir(path.join(seedDir, "assets"), { recursive: true });
    await fs.writeFile(path.join(seedDir, "assets", "big.bin"), POINTER);
    await fs.rm(path.join(seedDir, "README-old.md"));
    await seed.add("-A");
    await seed.commit("Add an LFS asset");
    await seed.push("origin", "main");
    return (await seed.revparse(["HEAD"])).trim();
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

  function git(...args: string[]): string {
    return execFileSync("git", ["-C", worktreeDir, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath },
    }).trim();
  }

  it("leaves the working tree clean when the merge dies, and fast-forwards once LFS works", async () => {
    await installFakeLfsFilter(false);

    const clone = runCli();
    expect(clone.status, clone.stdout + clone.stderr).toBe(0);
    const before = git("rev-parse", "HEAD");

    const tip = await pushLfsCommit();
    const failed = runCli();
    const failedOutput = failed.stdout + failed.stderr;

    expect(failed.status, failedOutput).toBe(1);
    expect(failedOutput).toContain("smudge filter lfs failed");
    expect(failed.stdout).toContain("1 failed");
    expect(failedOutput).not.toContain("working tree has local changes");

    expect(git("status", "--porcelain")).toBe("");
    expect(git("rev-parse", "HEAD")).toBe(before);
    for (const written of [".gitattributes", "0-plain.txt", "0-link.md", "0-dangling.md"]) {
      await expect(fs.lstat(path.join(worktreeDir, written))).rejects.toThrow();
    }
    await expect(fs.readFile(path.join(worktreeDir, "README-old.md"), "utf8")).resolves.toBe("# retired\n");
    expect(failed.stdout).toContain("Undid the half-applied fast-forward");
    expect(failedOutput).not.toContain("Could not hash");

    await repairLfsFilter();
    const repaired = runCli();
    expect(repaired.status, repaired.stdout + repaired.stderr).toBe(0);
    expect(repaired.stdout).toContain("1 synced");
    expect(repaired.stdout).toContain("Updated 'app' to origin/main");
    expect(git("rev-parse", "HEAD")).toBe(tip);
    expect(git("status", "--porcelain")).toBe("");
  }, 60_000);

  it("fast-forwards on the LFS-skipped retry when the filter honors the skip", async () => {
    await installFakeLfsFilter(true);

    const clone = runCli();
    expect(clone.status, clone.stdout + clone.stderr).toBe(0);

    const tip = await pushLfsCommit();
    const synced = runCli();
    const syncedOutput = synced.stdout + synced.stderr;

    expect(synced.status, syncedOutput).toBe(0);
    expect(syncedOutput).toContain("Temporarily disabling LFS downloads");
    expect(synced.stdout).toContain("Updated 'app' to origin/main");
    expect(synced.stdout).toContain("1 synced");
    expect(git("rev-parse", "HEAD")).toBe(tip);
    expect(git("status", "--porcelain")).toBe("");
    expect(await fs.readlink(path.join(worktreeDir, "0-link.md"))).toBe("README.md");
    await expect(fs.readFile(path.join(worktreeDir, "assets", "big.bin"), "utf8")).resolves.toBe(POINTER);
  }, 60_000);

  it("restores the old path of a rename that sorts before the failing path", async () => {
    await installFakeLfsFilter(false);
    const seed = simpleGit(seedDir);
    const body = "line of text that git can match across a rename\n".repeat(20);
    await fs.writeFile(path.join(seedDir, "0-a-old.txt"), body);
    await seed.add(".");
    await seed.commit("Add a file to rename");
    await seed.push("origin", "main");

    const clone = runCli();
    expect(clone.status, clone.stdout + clone.stderr).toBe(0);
    const before = git("rev-parse", "HEAD");

    await seed.raw(["mv", "0-a-old.txt", "0-b-new.txt"]);
    const tip = await pushLfsCommit();

    const failed = runCli();
    expect(failed.status, failed.stdout + failed.stderr).toBe(1);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("rev-parse", "HEAD")).toBe(before);
    await expect(fs.readFile(path.join(worktreeDir, "0-a-old.txt"), "utf8")).resolves.toBe(body);
    await expect(fs.lstat(path.join(worktreeDir, "0-b-new.txt"))).rejects.toThrow();

    await repairLfsFilter();
    const repaired = runCli();
    expect(repaired.status, repaired.stdout + repaired.stderr).toBe(0);
    expect(repaired.stdout).toContain("Updated 'app' to origin/main");
    expect(git("rev-parse", "HEAD")).toBe(tip);
    expect(git("status", "--porcelain")).toBe("");
  }, 60_000);

  it("still skips with dirty_tree for a change of the user's own", async () => {
    await installFakeLfsFilter(true);

    const clone = runCli();
    expect(clone.status, clone.stdout + clone.stderr).toBe(0);

    await fs.writeFile(path.join(worktreeDir, "README.md"), "# edited by hand\n");
    await pushLfsCommit();

    const skipped = runCli();
    expect(skipped.status, skipped.stdout + skipped.stderr).toBe(0);
    expect(skipped.stdout).toContain("working tree has local changes");
    expect(skipped.stdout).toContain("1 with clone-mode skips");
    await expect(fs.readFile(path.join(worktreeDir, "README.md"), "utf8")).resolves.toBe("# edited by hand\n");
  }, 60_000);
});
