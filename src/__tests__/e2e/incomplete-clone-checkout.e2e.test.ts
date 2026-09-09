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

// Real git, no git-lfs binary: a `filter.lfs` smudge driver that fails plus
// `filter.lfs.required` is exactly what a repository with an LFS object the
// server cannot serve does to `git clone` — the objects transfer, the checkout
// dies with "fatal: <file>: smudge filter lfs failed", and git exits 128 after
// printing "Clone succeeded, but checkout failed".
//
// What that leaves behind is a complete `.git` on the tracked branch next to a
// half-written working tree, and nothing on disk tells it apart from a clone
// the user made themselves: the next run adopted it as one and every sync
// after that soft-skipped with "working tree has local changes" at info level,
// exiting 0, for a directory the user never touched.
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
    // A second copy inside a directory, so a cone-mode sparse config can keep
    // the LFS file in the cone and leave something else out of it.
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

  // `honorsSkipEnv: true` stands in for git-lfs itself, which writes pointer
  // files instead of failing when GIT_LFS_SKIP_SMUDGE=1. The filter is reached
  // through GIT_CONFIG_GLOBAL because clone mode has no repository to configure
  // before the clone — which is also where a real `git lfs install` puts it.
  async function installFakeLfsFilter(honorsSkipEnv: boolean): Promise<void> {
    const body = honorsSkipEnv
      ? '#!/bin/sh\nif [ "$GIT_LFS_SKIP_SMUDGE" = "1" ]; then exec cat; fi\nexit 1\n'
      : "#!/bin/sh\nexit 1\n";
    await fs.writeFile(smudgeScript, body, { mode: 0o755 });
    // `clean = cat` mirrors git-lfs turning a working-tree file back into its
    // pointer: without a clean filter a required one fails every `git status`.
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

    // The state that used to be adopted: a real `.git` on the tracked branch,
    // a working tree git never finished writing.
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
    // The bug this replaces: an info-level skip and exit 0, every run, forever.
    expect(second.stdout).toContain("0 with clone-mode skips");
    expect(secondOutput).not.toContain("Clone-mode skips (");
    expect(secondOutput).not.toContain("working tree has local changes");
  }, 60_000);

  // Pre-existing hole the same fix closes: `skipLfs: true` put
  // GIT_LFS_SKIP_SMUDGE on every client except the sparse-checkout service's,
  // whose factory built one with no environment at all — so the repositories
  // that had asked for LFS to be skipped failed at the sparse step instead.
  it("applies sparse-checkout with LFS skipped when skipLfs is configured", async () => {
    await installFakeLfsFilter(true);
    await writeConfig(`\n      skipLfs: true,\n      sparseCheckout: { include: ["pkg"] },`);

    const first = runCli();
    const firstOutput = first.stdout + first.stderr;
    expect(first.status, firstOutput).toBe(0);
    // No recovery involved: with skipLfs the clone's own checkout succeeds, and
    // the sparse pass has to run the same way.
    expect(firstOutput).not.toContain("retrying the checkout with LFS disabled");
    expect(first.stdout).toContain("1 synced");
    await expect(fs.readFile(path.join(worktreeDir, "pkg", "big.bin"), "utf8")).resolves.toBe(POINTER);
    await expect(fs.access(path.join(worktreeDir, "other", "plain.txt"))).rejects.toThrow();
  }, 60_000);

  // `sparse-checkout set` materializes everything the cone brings in, so it
  // runs the smudge filter exactly like a checkout does. Handed a client
  // without the recovery's environment it dies on the objects the retry just
  // skipped — and leaves a narrowed tree that `git status` calls clean, which
  // is the silent wrongness this whole item is about.
  it("recovers a clone whose sparse-checkout cone holds the failing LFS file", async () => {
    await installFakeLfsFilter(true);
    await writeConfig(`\n      sparseCheckout: { include: ["pkg"] },`);

    const first = runCli();
    const firstOutput = first.stdout + first.stderr;
    expect(first.status, firstOutput).toBe(0);
    expect(first.stdout).toContain("Applying sparse-checkout patterns");
    expect(first.stdout).toContain("1 synced");

    // In the cone and materialized as a pointer; out of the cone and absent.
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
    // Honest about what the retry produced: the tree holds pointer files.
    expect(firstOutput).toContain("checked out with LFS smudging disabled");
    expect(first.stdout).toContain("1 synced");

    await expect(fs.readFile(path.join(worktreeDir, "big.bin"), "utf8")).resolves.toBe(POINTER);
    const status = await simpleGit(worktreeDir).raw(["status", "--short"]);
    expect(status.trim()).toBe("");
    await expect(fs.access(markerPath())).rejects.toThrow();

    // A repaired clone is an ordinary one from here on.
    const second = runCli();
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toContain("already up to date with origin/main");
    expect(second.stdout).toContain("0 with clone-mode skips");
  }, 60_000);
});
