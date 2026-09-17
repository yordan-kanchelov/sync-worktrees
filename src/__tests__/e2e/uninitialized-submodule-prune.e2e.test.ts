import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GIT_CONSTANTS, TRASH_CONSTANTS } from "../../constants";
import { PathResolutionService } from "../../services/path-resolution.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { createMockLogger } from "../test-utils";

import type { Logger } from "../../services/logger.service";
import type { RepositoryConfig, SyncOutcome } from "../../types";

// Real git, no mocks. `git worktree add` never initializes submodules, so every
// worktree this tool builds for a repo with a `.gitmodules` entry reports
// `-<oid> <path>` — git's "not initialized" marker — from `git submodule
// status`. That marker used to be classified as "modified submodules", which
// made `canRemove` false forever: a clean, fully pushed worktree whose branch
// was deleted upstream was skipped as `unsafe_to_remove` on every single sync
// and its directory was never trashed.
describe("Uninitialized submodules do not block pruning (E2E)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let remote: string;
  let submoduleRemote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let featPath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-submodule-")));
    remote = path.join(tempDir, "remote", "app.git");
    submoduleRemote = path.join(tempDir, "remote", "sub.git");
    seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    featPath = pathResolution.getBranchWorktreePath(worktreeDir, "feature/a");

    await fs.mkdir(path.dirname(remote), { recursive: true });
    await simpleGit().init(["--bare", remote]);
    await simpleGit().init(["--bare", submoduleRemote]);

    // The submodule's own history, so the gitlink below points at a commit that
    // really exists in a real repository.
    const subSeedDir = path.join(tempDir, "sub-seed");
    await fs.mkdir(subSeedDir);
    const subSeed = simpleGit(subSeedDir);
    await subSeed.init();
    await subSeed.addConfig("user.name", "Test User");
    await subSeed.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(subSeedDir, "lib.txt"), "lib");
    await subSeed.add(".");
    await subSeed.commit("Initial submodule commit");
    await subSeed.branch(["-M", "main"]);
    await subSeed.addRemote("origin", submoduleRemote);
    await subSeed.push("origin", "main");
    const submoduleTip = (await subSeed.revparse(["HEAD"])).trim();

    await fs.mkdir(seedDir);
    const seed = simpleGit(seedDir);
    await seed.init();
    await seed.addConfig("user.name", "Test User");
    await seed.addConfig("user.email", "test@example.com");
    await fs.writeFile(path.join(seedDir, "README.md"), "# app");
    await fs.writeFile(
      path.join(seedDir, ".gitmodules"),
      '[submodule "libs/sub"]\n\tpath = libs/sub\n\turl = ../sub.git\n',
    );
    await seed.add([".gitmodules", "README.md"]);
    // The gitlink itself: `git submodule add` would need a file-protocol
    // allowance and a local checkout; the superproject only has to record the
    // 160000 entry for git to report the submodule as uninitialized later.
    await seed.raw(["update-index", "--add", "--cacheinfo", `160000,${submoduleTip},libs/sub`]);
    await seed.commit("Initial commit with submodule");
    await seed.branch(["-M", "main"]);
    await seed.addRemote("origin", remote);
    await seed.push("origin", "main");
    // feature/a carries no commits of its own, so it stays fully pushed once
    // its remote branch is gone and nothing but the submodule marker is left to
    // block its removal.
    await seed.checkoutLocalBranch("feature/a");
    await seed.push("origin", "feature/a");
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
      __configFileDir: tempDir,
    };
  }

  async function syncOnce(service: WorktreeSyncService): Promise<SyncOutcome> {
    const result = await service.sync();
    expect(result.started).toBe(true);
    if (!result.started) throw new Error("sync did not start");
    return result.outcome;
  }

  it("prunes a clean, fully pushed worktree whose submodule was never initialized", async () => {
    const service = new WorktreeSyncService(makeConfig(createMockLogger()));

    const first = await syncOnce(service);
    expect(first.counts.failed).toBe(0);

    // Precondition: this is exactly the state that used to read as "modified
    // submodules" — git's "not initialized" marker on an otherwise clean tree.
    const submoduleStatus = await simpleGit(featPath).raw(["submodule", "status"]);
    expect(submoduleStatus).toMatch(/^-[0-9a-f]{40} libs\/sub/m);
    expect((await simpleGit(featPath).status(["--ignore-submodules=none"])).isClean()).toBe(true);

    await simpleGit(remote).raw(["branch", "-D", "feature/a"]);

    const second = await syncOnce(service);

    expect(second.actions).toContainEqual({ kind: "removed", branch: "feature/a", path: featPath });
    expect(second.actions.filter((action) => action.kind === "skipped")).toEqual([]);
    await expect(fs.access(featPath)).rejects.toThrow();

    const trashRoot = path.join(worktreeDir, GIT_CONSTANTS.TRASH_DIR_NAME);
    const entries = await Promise.all(
      (await fs.readdir(trashRoot)).map(async (id) => {
        const manifest = JSON.parse(
          await fs.readFile(path.join(trashRoot, id, TRASH_CONSTANTS.MANIFEST_FILENAME), "utf8"),
        ) as { reason: string; branch: string | null };
        return { id, manifest };
      }),
    );
    expect(entries.map(({ manifest }) => manifest)).toContainEqual(
      expect.objectContaining({ reason: "prune", branch: "feature/a" }),
    );
  }, 60_000);
});
