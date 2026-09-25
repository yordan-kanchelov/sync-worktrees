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

// Real git and a real filesystem. A directory already sitting where a managed
// branch's worktree belongs, and not registered with git, is content sync did
// not create and cannot inspect — files someone left there by hand. With trash
// disabled it used to be deleted outright (`rm -rf`) when it held no `.git`.
// It must be quarantined under `.removed/` instead; only an empty directory,
// which holds nothing to lose, is removed.
describe("Stale directory at a managed path with trash disabled (E2E)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let featPath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-stale-dir-")));
    remote = path.join(tempDir, "remote", "app.git");
    const seedDir = path.join(tempDir, "seed");
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
    await fs.writeFile(path.join(seedDir, "README.md"), "# app\n");
    await seed.add(".");
    await seed.commit("Initial commit");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");
    await seed.push("origin", "main:refs/heads/feature/a");
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

  async function expectRegisteredWorktree(): Promise<void> {
    const list = await simpleGit(bareRepoDir).raw(["worktree", "list", "--porcelain"]);
    expect(list).toContain(`worktree ${featPath}\n`);
    await expect(fs.readFile(path.join(featPath, "README.md"), "utf8")).resolves.toBe("# app\n");
  }

  it("quarantines a non-empty directory without a .git instead of deleting it", async () => {
    await fs.mkdir(path.join(featPath, "notes"), { recursive: true });
    await fs.writeFile(path.join(featPath, "notes", "todo.txt"), "hand-written notes\n");

    const outcome = await syncOnce(new WorktreeSyncService(makeConfig(createMockLogger())));
    expect(outcome.counts.failed).toBe(0);

    await expectRegisteredWorktree();
    const removedRoot = path.join(path.dirname(featPath), GIT_CONSTANTS.REMOVED_DIR_NAME);
    const quarantined = await fs.readdir(removedRoot);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].endsWith(`-${path.basename(featPath)}`)).toBe(true);
    await expect(fs.readFile(path.join(removedRoot, quarantined[0], "notes", "todo.txt"), "utf8")).resolves.toBe(
      "hand-written notes\n",
    );
  }, 60_000);

  it("removes an empty directory without leaving a quarantine entry", async () => {
    await fs.mkdir(featPath, { recursive: true });

    const outcome = await syncOnce(new WorktreeSyncService(makeConfig(createMockLogger())));
    expect(outcome.counts.failed).toBe(0);

    await expectRegisteredWorktree();
    await expect(fs.access(path.join(path.dirname(featPath), GIT_CONSTANTS.REMOVED_DIR_NAME))).rejects.toThrow();
  }, 60_000);
});
