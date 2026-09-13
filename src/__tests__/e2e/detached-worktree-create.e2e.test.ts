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

// Real git, no mocks. `git checkout <sha>` inside a managed worktree — the way
// anyone inspects history — leaves it registered but detached, and
// `git worktree list` says so. The sync inventory drops detached entries, so
// the branch looks new again and the create phase runs at a path that is
// already a worktree. Nothing is created there; the outcome and the log used to
// claim a fresh "✅ Created worktree" for it on every single tick.
describe("A detached managed worktree is skipped, not re-created (E2E)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let featurePath: string;
  let logger: Logger;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-detached-")));
    remote = path.join(tempDir, "remote", "app.git");
    seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    featurePath = pathResolution.getBranchWorktreePath(worktreeDir, "feature-x");
    logger = createMockLogger();

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);

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
    // Two commits on feature-x, so the worktree can be detached onto the older
    // one and any move away from it is visible.
    await seed.checkoutLocalBranch("feature-x");
    await fs.writeFile(path.join(seedDir, "feature.txt"), "first");
    await seed.add(".");
    await seed.commit("feature first");
    await fs.writeFile(path.join(seedDir, "feature.txt"), "second");
    await seed.add(".");
    await seed.commit("feature second");
    await seed.push("origin", "feature-x");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeConfig(): RepositoryConfig {
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

  function loggedLines(): string[] {
    return [logger.info, logger.warn, logger.error].flatMap((method) =>
      (method as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((args) => args.join(" ")),
    );
  }

  it("records a skip naming the path and leaves the worktree exactly as it was", async () => {
    const service = new WorktreeSyncService(makeConfig());

    const first = await syncOnce(service);
    expect(first.actions).toContainEqual({ kind: "created", branch: "feature-x", path: featurePath });

    // The user checks an older commit out to look at history.
    const featureGit = simpleGit(featurePath);
    const previousCommit = (await featureGit.revparse(["HEAD~1"])).trim();
    await featureGit.raw(["checkout", previousCommit]);
    expect((await featureGit.revparse(["HEAD"])).trim()).toBe(previousCommit);

    (logger.info as unknown as { mockClear: () => void }).mockClear();
    const second = await syncOnce(service);

    expect(second.counts.failed).toBe(0);
    expect(second.actions.filter((action) => action.kind === "created")).toEqual([]);
    expect(second.actions).toContainEqual(
      expect.objectContaining({
        kind: "skipped",
        scope: "worktree",
        reason: "detached_worktree",
        branch: "feature-x",
        path: featurePath,
        message: expect.stringContaining(featurePath),
      }),
    );
    expect(loggedLines().some((line) => line.includes("Created worktree"))).toBe(false);

    // The worktree is untouched: same detached HEAD, still registered once, and
    // no second directory was made for the same branch.
    expect((await featureGit.revparse(["HEAD"])).trim()).toBe(previousCommit);
    await expect(fs.readFile(path.join(featurePath, "feature.txt"), "utf8")).resolves.toBe("first");
    const registrations = (await simpleGit(bareRepoDir).raw(["worktree", "list", "--porcelain"]))
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
    expect(registrations.filter((line) => line.endsWith(featurePath))).toHaveLength(1);
    expect((await fs.readdir(worktreeDir)).sort()).toEqual([path.basename(featurePath), "main"].sort());
  }, 60_000);

  it("creates and syncs the worktree again once the branch is checked back out", async () => {
    const service = new WorktreeSyncService(makeConfig());
    await syncOnce(service);

    const featureGit = simpleGit(featurePath);
    await featureGit.raw(["checkout", (await featureGit.revparse(["HEAD~1"])).trim()]);
    await syncOnce(service);

    await featureGit.raw(["checkout", "feature-x"]);
    const afterReattach = await syncOnce(service);

    expect(afterReattach.counts.failed).toBe(0);
    expect(afterReattach.actions.filter((action) => action.kind === "skipped")).toEqual([]);
    await expect(fs.readFile(path.join(featurePath, "feature.txt"), "utf8")).resolves.toBe("second");
  }, 60_000);
});
