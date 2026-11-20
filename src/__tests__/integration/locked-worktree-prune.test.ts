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

describe("Locked worktrees are skipped, not pruned (E2E)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let featPath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-locked-")));
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

  async function lockFeatureAndDeleteItsRemoteBranch(): Promise<void> {
    await simpleGit(bareRepoDir).raw(["worktree", "lock", "--reason", "demo box", featPath]);
    await simpleGit(remote).raw(["branch", "-D", "feature/a"]);
  }

  it.each([
    ["trash enabled", true],
    ["trash disabled", false],
  ])(
    "skips a locked worktree whose remote branch was deleted (%s)",
    async (_label, trashEnabled) => {
      const service = new WorktreeSyncService(makeConfig(createMockLogger(), trashEnabled));

      const first = await syncOnce(service);
      expect(first.counts.failed).toBe(0);
      await expect(fs.access(featPath)).resolves.toBeUndefined();

      await lockFeatureAndDeleteItsRemoteBranch();

      const second = await syncOnce(service);

      expect(second.counts.failed).toBe(0);
      expect(second.actions.filter((action) => action.kind === "failed")).toEqual([]);
      expect(second.actions).toContainEqual(
        expect.objectContaining({
          kind: "skipped",
          branch: "feature/a",
          path: featPath,
          message: expect.stringContaining("locked"),
        }),
      );

      await expect(fs.access(path.join(featPath, "README.md"))).resolves.toBeUndefined();
      const registered = await simpleGit(bareRepoDir).raw(["worktree", "list", "--porcelain"]);
      expect(registered).toContain(featPath);
      expect(registered).toContain("locked demo box");

      await expect(fs.readdir(path.join(worktreeDir, GIT_CONSTANTS.TRASH_DIR_NAME))).rejects.toThrow();

      const third = await syncOnce(service);
      expect(third.counts.failed).toBe(0);
      await expect(fs.access(featPath)).resolves.toBeUndefined();
    },
    60_000,
  );

  it("prunes the same worktree once the user unlocks it", async () => {
    const service = new WorktreeSyncService(makeConfig(createMockLogger(), false));

    await syncOnce(service);
    await lockFeatureAndDeleteItsRemoteBranch();
    await syncOnce(service);

    await simpleGit(bareRepoDir).raw(["worktree", "unlock", featPath]);

    const afterUnlock = await syncOnce(service);

    expect(afterUnlock.counts.failed).toBe(0);
    expect(afterUnlock.actions).toContainEqual({ kind: "removed", branch: "feature/a", path: featPath });
    await expect(fs.access(featPath)).rejects.toThrow();
  }, 60_000);
});
