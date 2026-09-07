import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PathResolutionService } from "../../services/path-resolution.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { createMockLogger } from "../test-utils";

import type { Logger } from "../../services/logger.service";
import type { RepositoryConfig, SyncOutcome } from "../../types";

// Real git, no git-lfs binary: a fake `filter.lfs` smudge driver plus
// `filter.lfs.required` reproduces exactly what a broken LFS setup does to
// `git worktree add` — "fatal: <file>: smudge filter lfs failed" out of the
// checkout. `git fetch` into the bare repo never runs that filter, so the
// fetch-side LFS fallback never sees it: before this branch the create was
// recorded as create_failed, dropped by the create phase's allSettled, and
// repeated on the next tick forever, with a local branch left behind by the
// failed add each time.
describe("LFS smudge failures during worktree creation (E2E)", () => {
  const pathResolution = new PathResolutionService();
  const POINTER = "version https://git-lfs.github.com/spec/v1\noid sha256:d0d0\nsize 12\n";

  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let smudgeScript: string;
  let lfsBranchPath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-lfs-")));
    remote = path.join(tempDir, "remote", "app.git");
    seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    smudgeScript = path.join(tempDir, "fake-lfs-smudge.sh");
    lfsBranchPath = pathResolution.getBranchWorktreePath(worktreeDir, "feature/lfs");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

    await fs.mkdir(seedDir);
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(seedDir, ".gitattributes"), "*.bin filter=lfs\n");
    await fs.writeFile(path.join(seedDir, "README.md"), "# app\n");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeConfig(logger: Logger): RepositoryConfig {
    return {
      name: "app",
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      logger,
      retry: { maxAttempts: 1, initialDelayMs: 0 },
      trash: { enabled: false },
      __configFileDir: tempDir,
    };
  }

  async function syncOnce(service: WorktreeSyncService): Promise<SyncOutcome> {
    const result = await service.sync();
    expect(result.started).toBe(true);
    if (!result.started) throw new Error("sync did not start");
    return result.outcome;
  }

  // `honorsSkipEnv: true` is a stand-in for git-lfs itself, which checks out
  // pointer files instead of failing when GIT_LFS_SKIP_SMUDGE=1.
  async function installFakeLfsFilter(honorsSkipEnv: boolean): Promise<void> {
    const body = honorsSkipEnv
      ? '#!/bin/sh\nif [ "$GIT_LFS_SKIP_SMUDGE" = "1" ]; then exec cat; fi\nexit 1\n'
      : "#!/bin/sh\nexit 1\n";
    await fs.writeFile(smudgeScript, body, { mode: 0o755 });

    // Written straight into the bare repo's config file: simple-git refuses to
    // set `filter.*` keys, and this is where a real git-lfs install would have
    // put them (`git lfs install` writes them globally or per repository).
    const configPath = path.join(bareRepoDir, "config");
    const config = await fs.readFile(configPath, "utf8");
    await fs.writeFile(configPath, `${config}[filter "lfs"]\n\tsmudge = ${smudgeScript}\n\trequired = true\n`);
  }

  async function pushBranchWithLfsFile(): Promise<void> {
    const seed = simpleGit(seedDir);
    await seed.checkoutLocalBranch("feature/lfs");
    await fs.writeFile(path.join(seedDir, "big.bin"), POINTER);
    await seed.add(".");
    await seed.commit("Add an LFS-tracked file");
    await seed.push("origin", "feature/lfs");
  }

  it("falls back to LFS-free checkout and creates the worktree", async () => {
    const service = new WorktreeSyncService(makeConfig(createMockLogger()));

    // First sync builds the bare repo and the default branch's worktree; the
    // broken filter is configured on it afterwards, exactly as a user's global
    // git-lfs install would already be there for a repo that needs it.
    await syncOnce(service);
    await installFakeLfsFilter(true);
    await pushBranchWithLfsFile();

    const outcome = await syncOnce(service);

    expect(outcome.counts).toMatchObject({ created: 1, failed: 0 });
    expect(outcome.actions).toContainEqual(
      expect.objectContaining({ kind: "created", branch: "feature/lfs", path: lfsBranchPath }),
    );
    expect(outcome.actions).toContainEqual(
      expect.objectContaining({ kind: "noop", scope: "repo", reason: "lfs_skip_enabled", branch: "feature/lfs" }),
    );
    // The worktree holds the pointer file, which is what a skipped smudge
    // leaves behind — not a failed sync.
    await expect(fs.readFile(path.join(lfsBranchPath, "big.bin"), "utf8")).resolves.toBe(POINTER);

    // The skip was temporary: the next sync starts with LFS downloads on again.
    const third = await syncOnce(service);
    expect(third.counts.failed).toBe(0);
    expect(third.actions.some((action) => "reason" in action && action.reason === "lfs_skip_enabled")).toBe(false);
  }, 60_000);

  it("leaves no local branch behind when the checkout fails even with LFS skipped", async () => {
    const service = new WorktreeSyncService(makeConfig(createMockLogger()));

    await syncOnce(service);
    await installFakeLfsFilter(false);
    await pushBranchWithLfsFile();

    const outcome = await syncOnce(service);

    expect(outcome.counts).toMatchObject({ created: 0, failed: 1 });
    expect(outcome.actions).toContainEqual(
      expect.objectContaining({
        kind: "failed",
        reason: "create_failed",
        branch: "feature/lfs",
        error: expect.stringContaining("smudge filter lfs failed"),
      }),
    );
    await expect(fs.access(lfsBranchPath)).rejects.toThrow();

    // git creates refs/heads/feature/lfs before it checks the files out and
    // keeps it when the checkout fails. Left there, the next sync would add the
    // worktree from that local ref instead of origin/feature/lfs.
    const localBranches = await simpleGit(bareRepoDir).raw(["branch", "--list", "feature/lfs"]);
    expect(localBranches.trim()).toBe("");
  }, 60_000);
});
