import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PathResolutionService } from "../../services/path-resolution.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { createMockLogger } from "../test-utils";

import type { RepositoryConfig, SparseCheckoutConfig, SyncOutcome } from "../../types";

// The update phase's counterpart of lfs-smudge-worktree-create: the checkout
// inside `merge --ff-only` (and inside a widening `sparse-checkout set`) runs
// the smudge filter too. Without a fallback there the branch failed with
// update_failed on every tick, and the files git wrote before the failing
// path left the worktree dirty, so later ticks skipped it as dirty_worktree.
describe("LFS smudge failures while updating existing worktrees (E2E)", () => {
  const pathResolution = new PathResolutionService();
  const POINTER = "version https://git-lfs.github.com/spec/v1\noid sha256:d0d0\nsize 12\n";

  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let smudgeScript: string;
  let featurePath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-lfs-update-")));
    remote = path.join(tempDir, "remote", "app.git");
    seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    smudgeScript = path.join(tempDir, "fake-lfs-smudge.sh");
    featurePath = pathResolution.getBranchWorktreePath(worktreeDir, "feature/lfs");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

    await fs.mkdir(seedDir);
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(seedDir, ".gitattributes"), "*.bin filter=lfs\n");
    await fs.writeFile(path.join(seedDir, "README.md"), "# app\n");
    await fs.writeFile(path.join(seedDir, "README-old.md"), "# retired\n");
    await fs.mkdir(path.join(seedDir, "apps"));
    await fs.writeFile(path.join(seedDir, "apps", "index.ts"), "export {};\n");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");
    await seed.checkoutLocalBranch("feature/lfs");
    await seed.push("origin", "feature/lfs");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeConfig(sparseCheckout?: SparseCheckoutConfig): RepositoryConfig {
    return {
      name: "app",
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      logger: createMockLogger(),
      retry: { maxAttempts: 1, initialDelayMs: 0 },
      trash: { enabled: false },
      ...(sparseCheckout && { sparseCheckout }),
      __configFileDir: tempDir,
    };
  }

  async function syncOnce(service: WorktreeSyncService): Promise<SyncOutcome> {
    const result = await service.sync();
    expect(result.started).toBe(true);
    if (!result.started) throw new Error("sync did not start");
    return result.outcome;
  }

  // `honorsSkipEnv: true` stands in for git-lfs, which writes the pointer
  // instead of failing when GIT_LFS_SKIP_SMUDGE=1. Written into the bare
  // repo's config, which every worktree shares.
  async function installFakeLfsFilter(honorsSkipEnv: boolean): Promise<void> {
    const body = honorsSkipEnv
      ? '#!/bin/sh\nif [ "$GIT_LFS_SKIP_SMUDGE" = "1" ]; then exec cat; fi\nexit 1\n'
      : "#!/bin/sh\nexit 1\n";
    await fs.writeFile(smudgeScript, body, { mode: 0o755 });
    const configPath = path.join(bareRepoDir, "config");
    const config = await fs.readFile(configPath, "utf8");
    await fs.writeFile(
      configPath,
      `${config}[filter "lfs"]\n\tsmudge = ${smudgeScript}\n\tclean = cat\n\trequired = true\n`,
    );
  }

  async function repairLfsFilter(): Promise<void> {
    await fs.writeFile(smudgeScript, "#!/bin/sh\nexec cat\n", { mode: 0o755 });
  }

  // Everything but the LFS file sorts before it, so a failing smudge leaves a
  // half-applied checkout: an added file, a modified one and a deleted one.
  async function pushLfsCommit(lfsPath = "assets/big.bin"): Promise<string> {
    const seed = simpleGit(seedDir);
    await fs.writeFile(path.join(seedDir, "0-plain.txt"), "plain\n");
    await fs.writeFile(path.join(seedDir, "README.md"), "# app v2\n");
    await fs.rm(path.join(seedDir, "README-old.md"));
    await fs.mkdir(path.dirname(path.join(seedDir, lfsPath)), { recursive: true });
    await fs.writeFile(path.join(seedDir, lfsPath), POINTER);
    await seed.add("-A");
    await seed.commit("Add an LFS asset");
    await seed.push("origin", "feature/lfs");
    return (await seed.revparse(["HEAD"])).trim();
  }

  function git(...args: string[]): string {
    return execFileSync("git", ["-C", featurePath, ...args], { encoding: "utf8" }).trim();
  }

  it("fast-forwards with LFS downloads disabled when the update's checkout fails on LFS", async () => {
    const service = new WorktreeSyncService(makeConfig());
    await syncOnce(service);
    await installFakeLfsFilter(true);
    const tip = await pushLfsCommit();

    const outcome = await syncOnce(service);

    expect(outcome.counts).toMatchObject({ updated: 1, failed: 0 });
    expect(outcome.actions).toContainEqual(
      expect.objectContaining({ kind: "updated", branch: "feature/lfs", reason: "fast_forward" }),
    );
    expect(outcome.actions).toContainEqual(
      expect.objectContaining({ kind: "noop", scope: "repo", reason: "lfs_skip_enabled", branch: "feature/lfs" }),
    );
    expect(git("rev-parse", "HEAD")).toBe(tip);
    expect(git("status", "--porcelain")).toBe("");
    await expect(fs.readFile(path.join(featurePath, "assets", "big.bin"), "utf8")).resolves.toBe(POINTER);
  }, 60_000);

  it("undoes the half-applied fast-forward when even the LFS-free retry fails, so a fixed LFS heals it", async () => {
    const service = new WorktreeSyncService(makeConfig());
    await syncOnce(service);
    const before = git("rev-parse", "HEAD");
    await installFakeLfsFilter(false);
    const tip = await pushLfsCommit();

    const failed = await syncOnce(service);

    expect(failed.counts).toMatchObject({ updated: 0, failed: 1 });
    expect(failed.actions).toContainEqual(
      expect.objectContaining({
        kind: "failed",
        reason: "update_failed",
        branch: "feature/lfs",
        error: expect.stringContaining("smudge filter lfs failed"),
      }),
    );
    expect(git("rev-parse", "HEAD")).toBe(before);
    expect(git("status", "--porcelain")).toBe("");
    await expect(fs.readFile(path.join(featurePath, "README-old.md"), "utf8")).resolves.toBe("# retired\n");

    await repairLfsFilter();
    const repaired = await syncOnce(service);
    expect(repaired.counts).toMatchObject({ updated: 1, failed: 0 });
    expect(git("rev-parse", "HEAD")).toBe(tip);
    expect(git("status", "--porcelain")).toBe("");
  }, 60_000);

  it("re-applies a widened sparse-checkout with LFS downloads disabled when its checkout fails on LFS", async () => {
    await syncOnce(new WorktreeSyncService(makeConfig({ include: ["apps"] })));
    await installFakeLfsFilter(true);
    // Outside the cone, so the fast-forward never smudges it; the widening does.
    await pushLfsCommit("libs/big.bin");

    const outcome = await syncOnce(new WorktreeSyncService(makeConfig({ include: ["apps", "libs"] })));

    expect(outcome.counts.failed).toBe(0);
    expect(outcome.actions).toContainEqual(
      expect.objectContaining({ kind: "updated", branch: "feature/lfs", reason: "sparse_checkout" }),
    );
    expect(outcome.actions).toContainEqual(
      expect.objectContaining({ kind: "noop", scope: "repo", reason: "lfs_skip_enabled", branch: "feature/lfs" }),
    );
    await expect(fs.readFile(path.join(featurePath, "libs", "big.bin"), "utf8")).resolves.toBe(POINTER);
    expect(git("status", "--porcelain")).toBe("");
  }, 60_000);
});
