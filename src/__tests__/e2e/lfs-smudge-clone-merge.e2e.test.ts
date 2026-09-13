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

// Real git, no git-lfs binary: a `filter.lfs` smudge driver that fails plus
// `filter.lfs.required` is what a repository whose LFS server cannot be reached
// does to a checkout. Here the checkout is the one inside `merge --ff-only`, so
// git stops at the first path it cannot produce with the paths that sort before
// it already written, and with HEAD and the index still on the old commit.
//
// What that used to leave behind wedged the repository for good: `git status`
// reported the stray files, every following tick soft-skipped with "working
// tree has local changes" at info level and exit 0, and even a repaired LFS
// server could not end it — git refuses to overwrite the untracked files the
// first attempt left.
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
    // Sorts before the LFS path, so the incoming commit's deletion of it is
    // applied before git gives up — the other half of the half-applied
    // checkout, and the one the cleanup has to put back rather than delete.
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

  // `honorsSkipEnv: true` stands in for git-lfs itself, which writes the
  // pointer file instead of failing when GIT_LFS_SKIP_SMUDGE=1; false is the
  // filter that has no such escape hatch. The config is reached through
  // GIT_CONFIG_GLOBAL, which is also where `git lfs install` puts it.
  async function installFakeLfsFilter(honorsSkipEnv: boolean): Promise<void> {
    const body = honorsSkipEnv
      ? '#!/bin/sh\nif [ "$GIT_LFS_SKIP_SMUDGE" = "1" ]; then exec cat; fi\nexit 1\n'
      : "#!/bin/sh\nexit 1\n";
    await fs.writeFile(smudgeScript, body, { mode: 0o755 });
    // `clean = cat` mirrors git-lfs turning a working-tree file back into its
    // pointer: without a clean filter a required one fails every `git status`.
    await fs.writeFile(gitConfigPath, `[filter "lfs"]\n\tsmudge = ${smudgeScript}\n\tclean = cat\n\trequired = true\n`);
  }

  // The LFS server coming back: from here the smudge filter answers for
  // everything.
  async function repairLfsFilter(): Promise<void> {
    await fs.writeFile(smudgeScript, "#!/bin/sh\nexec cat\n", { mode: 0o755 });
  }

  // The upstream commit the failing filter cannot check out. Everything but the
  // LFS file sorts before it, so git writes all of it and then gives up:
  // a plain file, a symlink, a symlink whose target the merge never reaches
  // (`hash-object` follows a symlink and dies on a dangling one, so neither can
  // be proved by hashing), and the removal of a tracked file.
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

  // Run with the same filter config the CLI saw, so `git status` classifies the
  // working tree exactly as the tool's own status call did.
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

    // A filter with no escape hatch: the sync fails, loudly, naming the cause.
    expect(failed.status, failedOutput).toBe(1);
    expect(failedOutput).toContain("smudge filter lfs failed");
    expect(failed.stdout).toContain("1 failed");
    // Not the silent skip this item is about.
    expect(failedOutput).not.toContain("working tree has local changes");

    // The half-applied checkout is gone: the files git had already written are
    // removed — symlinks and the dangling one included — the one it had already
    // deleted is back, and HEAD never moved.
    expect(git("status", "--porcelain")).toBe("");
    expect(git("rev-parse", "HEAD")).toBe(before);
    for (const written of [".gitattributes", "0-plain.txt", "0-link.md", "0-dangling.md"]) {
      await expect(fs.lstat(path.join(worktreeDir, written))).rejects.toThrow();
    }
    await expect(fs.readFile(path.join(worktreeDir, "README-old.md"), "utf8")).resolves.toBe("# retired\n");
    expect(failed.stdout).toContain("Undid the half-applied fast-forward");
    // Nothing was left unproved: a dangling symlink used to fail the batch
    // `hash-object` and disqualify every path with it.
    expect(failedOutput).not.toContain("Could not hash");

    // Which is what lets the repository heal itself once LFS is reachable
    // again — the run that used to skip forever.
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

    // Attempt 1 dies on the smudge, the retry policy disables smudging, and the
    // retry's merge now actually runs with GIT_LFS_SKIP_SMUDGE=1.
    expect(synced.status, syncedOutput).toBe(0);
    expect(syncedOutput).toContain("Temporarily disabling LFS downloads");
    expect(synced.stdout).toContain("Updated 'app' to origin/main");
    expect(synced.stdout).toContain("1 synced");
    expect(git("rev-parse", "HEAD")).toBe(tip);
    expect(git("status", "--porcelain")).toBe("");
    expect(await fs.readlink(path.join(worktreeDir, "0-link.md"))).toBe("README.md");
    // Honest about what the retry produced: the LFS path holds its pointer.
    await expect(fs.readFile(path.join(worktreeDir, "assets", "big.bin"), "utf8")).resolves.toBe(POINTER);
  }, 60_000);

  // The cleanup only ever weighs paths the merge itself would have written, so
  // a clone somebody is working in still skips for the reason it always did.
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
