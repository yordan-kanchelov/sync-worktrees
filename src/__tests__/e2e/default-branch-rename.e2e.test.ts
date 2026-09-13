import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PathResolutionService } from "../../services/path-resolution.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { createMockLogger } from "../test-utils";

import type { Logger } from "../../services/logger.service";
import type { RepositoryConfig, SyncOutcome, SyncOutcomeAction } from "../../types";
import type { Mock } from "vitest";

// Real git, no mocks. refs/remotes/origin/HEAD is only ever written by
// `remote set-head`: after the remote renames its default branch (main ->
// trunk) and deletes the old one, `fetch --prune` drops origin/main but the
// symref keeps naming main. Sync used to keep main as the default forever —
// its worktree stayed an update candidate whose upstream was gone (every sync
// failed with diverged_recovery_failed), it was never pruned, and trunk was
// created as an ordinary hashed peer directory.
describe("Default branch renamed on the remote (E2E)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let mainPath: string;
  let trunkPath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-default-rename-")));
    remote = path.join(tempDir, "remote", "app.git");
    seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    mainPath = path.join(worktreeDir, "main");
    trunkPath = path.join(worktreeDir, "trunk");

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
    await seed.checkoutLocalBranch("feature-1");
    await fs.writeFile(path.join(seedDir, "feature-1.txt"), "Content for feature-1");
    await seed.add(".");
    await seed.commit("Add feature-1");
    await seed.push("origin", "feature-1");
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
      __configFileDir: tempDir,
    };
  }

  // The new default is pushed at main's tip plus one commit, so that a
  // worktree at origin's tip is distinguishable from one at main's.
  async function pushTrunk(): Promise<string> {
    const seed = simpleGit(seedDir);
    await seed.checkout("main");
    await seed.checkoutLocalBranch("trunk");
    await fs.writeFile(path.join(seedDir, "TRUNK.md"), "# trunk");
    await seed.add(".");
    await seed.commit("Rename default branch to trunk");
    await seed.push("origin", "trunk");
    return (await seed.revparse(["trunk"])).trim();
  }

  // The remote's side of the migration. A bare repository refuses to delete
  // its current branch, so HEAD moves first.
  async function retireMain(): Promise<void> {
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/trunk"]);
    await simpleGit(seedDir).push(["origin", "--delete", "main"]);
  }

  async function syncOutcome(service: WorktreeSyncService): Promise<SyncOutcome> {
    const result = await service.sync();
    expect(result.started).toBe(true);
    if (!result.started) throw new Error("sync did not start");
    return result.outcome;
  }

  const registeredWorktrees = async (service: WorktreeSyncService): Promise<{ path: string; branch: string }[]> =>
    (await service.getWorktrees()).map((w) => ({ path: path.resolve(w.path), branch: w.branch }));

  const actionsFor = (outcome: SyncOutcome, branch: string): SyncOutcomeAction[] =>
    outcome.actions.filter((action) => action.branch === branch);

  const infoLines = (logger: Logger): string[] => (logger.info as Mock).mock.calls.map((call) => String(call[0]));

  const originHead = async (): Promise<string> =>
    (await simpleGit(bareRepoDir).raw(["symbolic-ref", "refs/remotes/origin/HEAD"])).trim();

  it("switches to the renamed default, creates its worktree, prunes the old one and keeps fetching", async () => {
    const logger = createMockLogger();
    const service = new WorktreeSyncService(makeConfig(logger));
    await service.initialize();
    expect((await syncOutcome(service)).counts.failed).toBe(0);
    expect(await service.getDefaultBranch()).toBe("main");

    const trunkTip = await pushTrunk();
    await retireMain();

    // The same process keeps running: initialize() is a no-op and the sync
    // re-resolves the default after its fetch pruned origin/main.
    await service.initialize();
    const outcome = await syncOutcome(service);

    expect(outcome.counts.failed).toBe(0);
    expect(await service.getDefaultBranch()).toBe("trunk");
    expect(infoLines(logger)).toContain("Default branch changed from 'main' to 'trunk' on origin.");
    expect(await originHead()).toBe("refs/remotes/origin/trunk");

    // trunk got the default branch's worktree — not a hashed peer directory —
    // at origin's tip, so the same sync's update phase found nothing to do.
    expect(actionsFor(outcome, "trunk")).toEqual([
      { kind: "created", branch: "trunk", path: trunkPath },
      expect.objectContaining({ kind: "noop", reason: "already_up_to_date", path: trunkPath }),
    ]);
    const worktrees = await registeredWorktrees(service);
    expect(worktrees).toContainEqual({ path: trunkPath, branch: "trunk" });
    expect(worktrees.map((w) => w.path)).not.toContain(pathResolution.getBranchWorktreePath(worktreeDir, "trunk"));
    expect((await simpleGit(trunkPath).revparse(["HEAD"])).trim()).toBe(trunkTip);
    await expect(fs.readFile(path.join(trunkPath, "TRUNK.md"), "utf8")).resolves.toBe("# trunk");

    // main was a prune candidate — never an update candidate — and, being
    // fully pushed before its deletion, was moved to trash.
    expect(actionsFor(outcome, "main")).toEqual([
      expect.objectContaining({ kind: "removed", branch: "main", path: mainPath }),
    ]);
    expect(worktrees.map((w) => w.branch)).not.toContain("main");
    await expect(fs.access(mainPath)).rejects.toThrow();

    // The next fetch runs from the trunk worktree; the old anchor is gone.
    const second = await syncOutcome(service);
    expect(second.counts.failed).toBe(0);
    expect(actionsFor(second, "trunk")).toEqual([
      expect.objectContaining({ kind: "noop", reason: "already_up_to_date", path: trunkPath }),
    ]);
    expect(actionsFor(second, "main")).toEqual([]);
    expect(await registeredWorktrees(service)).toContainEqual({ path: trunkPath, branch: "trunk" });
  });

  it("adopts the worktree the new default already had as an ordinary branch instead of creating a second one", async () => {
    const logger = createMockLogger();
    const service = new WorktreeSyncService(makeConfig(logger));
    await service.initialize();

    // trunk is synced as an ordinary branch first, under its hashed directory...
    await pushTrunk();
    expect((await syncOutcome(service)).counts.failed).toBe(0);
    const hashedTrunkPath = pathResolution.getBranchWorktreePath(worktreeDir, "trunk");
    expect(await registeredWorktrees(service)).toContainEqual({ path: hashedTrunkPath, branch: "trunk" });

    // ...then the remote makes it the default and deletes main.
    await retireMain();
    const outcome = await syncOutcome(service);

    expect(outcome.counts.failed).toBe(0);
    expect(await service.getDefaultBranch()).toBe("trunk");
    expect(infoLines(logger)).toContainEqual(
      expect.stringContaining(`trunk is already checked out at "${hashedTrunkPath}"`),
    );
    expect(actionsFor(outcome, "trunk")).toEqual([
      expect.objectContaining({ kind: "noop", reason: "already_up_to_date", path: hashedTrunkPath }),
    ]);
    await expect(fs.access(trunkPath)).rejects.toThrow();
    expect(actionsFor(outcome, "main")).toEqual([
      expect.objectContaining({ kind: "removed", branch: "main", path: mainPath }),
    ]);

    // Fetches run from the adopted worktree from now on.
    const second = await syncOutcome(service);
    expect(second.counts.failed).toBe(0);
    expect(await registeredWorktrees(service)).toEqual([
      expect.objectContaining({ branch: "feature-1" }),
      { path: hashedTrunkPath, branch: "trunk" },
    ]);
  });

  it("re-resolves a stale origin/HEAD when a new process initializes after the rename", async () => {
    const first = new WorktreeSyncService(makeConfig(createMockLogger()));
    await first.initialize();
    expect((await syncOutcome(first)).counts.failed).toBe(0);

    await pushTrunk();
    await retireMain();
    // Another process already pruned origin/main; origin/HEAD still names main.
    await simpleGit(bareRepoDir).fetch(["--all", "--prune"]);
    expect(await originHead()).toBe("refs/remotes/origin/main");
    expect((await simpleGit(bareRepoDir).branch(["-r"])).all).not.toContain("origin/main");

    const logger = createMockLogger();
    const second = new WorktreeSyncService(makeConfig(logger));
    await second.initialize();

    expect(await second.getDefaultBranch()).toBe("trunk");
    expect(await originHead()).toBe("refs/remotes/origin/trunk");
    expect(infoLines(logger)).toContainEqual(
      expect.stringContaining("origin/HEAD points at 'main', which no longer exists on origin"),
    );
    expect(await registeredWorktrees(second)).toContainEqual({ path: trunkPath, branch: "trunk" });

    const outcome = await syncOutcome(second);
    expect(outcome.counts.failed).toBe(0);
    expect(actionsFor(outcome, "main")).toEqual([
      expect.objectContaining({ kind: "removed", branch: "main", path: mainPath }),
    ]);
    expect(actionsFor(outcome, "trunk")).toEqual([
      expect.objectContaining({ kind: "noop", reason: "already_up_to_date", path: trunkPath }),
    ]);
  });
});
