import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GIT_CONSTANTS } from "../../constants";
import { PathResolutionService } from "../../services/path-resolution.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { createMockLogger } from "../test-utils";

import type { Logger } from "../../services/logger.service";
import type { RepositoryConfig, SyncOutcome } from "../../types";

// Real git. A locked worktree whose branch diverges with local changes must be
// left in place as a worktree_locked skip: git refuses to remove it, so moving
// it aside either strands a locked registration (trash off) or fails every
// tick (trash on).
describe("Locked diverged worktrees are skipped, not moved (E2E)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let featPath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-locked-div-")));
    remote = path.join(tempDir, "remote", "app.git");
    seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    featPath = pathResolution.getBranchWorktreePath(worktreeDir, "feature/a");

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
    await seed.checkoutLocalBranch("feature/a");
    await fs.writeFile(path.join(seedDir, "feature.txt"), "upstream v1");
    await seed.add(".");
    await seed.commit("Add feature");
    await seed.push("origin", "feature/a");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeConfig(logger: Logger, trashEnabled: boolean): RepositoryConfig {
    return {
      name: "app",
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      logger,
      retry: { maxAttempts: 1, initialDelayMs: 0 },
      ...(trashEnabled ? {} : { trash: { enabled: false } }),
      __configFileDir: tempDir,
    };
  }

  async function syncOnce(service: WorktreeSyncService): Promise<SyncOutcome> {
    const result = await service.sync();
    expect(result.started).toBe(true);
    if (!result.started) throw new Error("sync did not start");
    return result.outcome;
  }

  async function lockAndDiverge(): Promise<string> {
    await simpleGit(bareRepoDir).raw(["worktree", "lock", "--reason", "demo box", featPath]);

    const wt = simpleGit(featPath);
    await wt.addConfig("user.name", "Test User");
    await wt.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(featPath, "local-only.txt"), "never pushed");
    await wt.add(".");
    await wt.commit("local only work");

    const seed = simpleGit(seedDir);
    await fs.writeFile(path.join(seedDir, "feature.txt"), "upstream v2");
    await seed.add(".");
    await seed.commit("upstream rewrite");
    await seed.push(["origin", "feature/a"]);

    return (await wt.revparse(["HEAD"])).trim();
  }

  it.each([
    ["trash enabled", true],
    ["trash disabled", false],
  ])(
    "leaves a locked diverged worktree in place as a worktree_locked skip (%s)",
    async (_label, trashEnabled) => {
      const service = new WorktreeSyncService(makeConfig(createMockLogger(), trashEnabled));

      const first = await syncOnce(service);
      expect(first.counts.failed).toBe(0);

      const localCommit = await lockAndDiverge();

      const dryRun = await service.planSync();
      if (!dryRun.started) throw new Error("dry run did not start");
      expect(dryRun.plan.steps).toContainEqual(
        expect.objectContaining({ kind: "skip", reason: "worktree_locked", branch: "feature/a", path: featPath }),
      );
      expect(dryRun.plan.steps.filter((step) => step.kind === "replace")).toEqual([]);

      for (let tick = 0; tick < 2; tick++) {
        const outcome = await syncOnce(service);

        expect(outcome.counts.failed).toBe(0);
        expect(outcome.actions.filter((action) => action.kind === "failed")).toEqual([]);
        expect(outcome.actions).toContainEqual(
          expect.objectContaining({
            kind: "skipped",
            reason: "worktree_locked",
            branch: "feature/a",
            path: featPath,
            message: expect.stringContaining("demo box"),
          }),
        );
        expect(outcome.actions.filter((action) => action.kind === "preserved-diverged")).toEqual([]);

        // The worktree is untouched: same commit, still registered and locked.
        expect((await simpleGit(featPath).revparse(["HEAD"])).trim()).toBe(localCommit);
        await expect(fs.readFile(path.join(featPath, "local-only.txt"), "utf8")).resolves.toBe("never pushed");
        const registered = await simpleGit(bareRepoDir).raw(["worktree", "list", "--porcelain"]);
        expect(registered).toContain(featPath);
        expect(registered).toContain("locked demo box");
        await expect(fs.readdir(path.join(worktreeDir, GIT_CONSTANTS.DIVERGED_DIR_NAME))).rejects.toThrow();
        await expect(fs.readdir(path.join(worktreeDir, GIT_CONSTANTS.TRASH_DIR_NAME))).rejects.toThrow();
      }
    },
    90_000,
  );
});
