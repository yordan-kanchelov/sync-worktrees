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

// Real git, no mocks. `git worktree lock` is how a user tells git "leave this
// directory alone" — a demo box, a mounted volume, a long-running build. Git
// then refuses `worktree remove` even with a single --force ("cannot remove a
// locked working tree ... use 'remove -f -f'"). Sync used to walk a locked
// worktree whose remote branch was deleted straight into the prune pipeline:
// with trash on it size-scanned the directory, renamed it into .trash/, failed
// to unregister and renamed it back — every tick; with trash off git's refusal
// fell through to the generic handler, so every sync logged
// "❌ Failed to remove worktree" and exited 1.
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
    // feature/a carries no commits of its own, so nothing but the lock can
    // stand between it and removal once its remote branch is gone.
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

      // The removal is a deliberate skip that names the lock, not a failure.
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

      // The worktree is untouched: still on disk, still registered, still locked.
      await expect(fs.access(path.join(featPath, "README.md"))).resolves.toBeUndefined();
      const registered = await simpleGit(bareRepoDir).raw(["worktree", "list", "--porcelain"]);
      expect(registered).toContain(featPath);
      expect(registered).toContain("locked demo box");

      // And nothing was moved into trash on the way to that skip.
      await expect(fs.readdir(path.join(worktreeDir, GIT_CONSTANTS.TRASH_DIR_NAME))).rejects.toThrow();

      // A second tick behaves the same way — no exit-code churn, no repeated
      // rename of the whole directory.
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
