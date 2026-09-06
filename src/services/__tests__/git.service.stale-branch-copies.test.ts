import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { PathResolutionService } from "../path-resolution.service";
import { WorktreeSyncService } from "../worktree-sync.service";

import type { RepositoryConfig, SyncOutcomeAction } from "../../types";
import type { Mock } from "vitest";

// Real git, no mocks. `git clone --bare` copies every remote branch into
// refs/heads/*, and the fetch refspec only ever updates refs/remotes/origin/*,
// so those copies stay frozen at clone time. A worktree added later for such a
// branch used to check out the frozen tip, be reported as created with
// tracking, and then read as behind or diverged on the next sync — a reset
// with a warning, or the directory moved aside as diverged. Two halves: a
// fresh clone drops the copies, and a local ref that is only behind is moved to
// origin's tip when its worktree is created. A local ref with commits not on
// origin keeps its tip, and the sync says so.
describe("GitService worktree creation from stale local branch refs", () => {
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let featurePath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-stale-refs-")));
    remote = path.join(tempDir, "remote", "app.git");
    seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    featurePath = new PathResolutionService().getBranchWorktreePath(worktreeDir, "feature");

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
    await seed.checkoutLocalBranch("feature");
    await fs.writeFile(path.join(seedDir, "feature.txt"), "v1");
    await seed.add(".");
    await seed.commit("Add feature v1");
    await seed.push("origin", "feature");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeConfig(overrides: Partial<RepositoryConfig> = {}): RepositoryConfig {
    return {
      name: "app",
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      logger: createMockLogger(),
      __configFileDir: tempDir,
      ...overrides,
    };
  }

  const revParse = async (repoPath: string, ref: string): Promise<string> =>
    (await simpleGit(repoPath).raw(["rev-parse", ref])).trim();

  const localHeads = async (): Promise<string[]> =>
    (await simpleGit(bareRepoDir).raw(["for-each-ref", "--format=%(refname)", "refs/heads/"]))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort();

  const upstreamOf = async (worktreePath: string): Promise<string> =>
    (await simpleGit(worktreePath).raw(["rev-parse", "--abbrev-ref", "feature@{upstream}"])).trim();

  // Advance the remote's feature branch; `rewrite` amends the tip and force-pushes instead.
  async function pushFeature(content: string, opts: { rewrite?: boolean } = {}): Promise<void> {
    const seed = simpleGit(seedDir);
    await seed.checkout("feature");
    await fs.writeFile(path.join(seedDir, "feature.txt"), content);
    await seed.add(".");
    if (opts.rewrite) {
      await seed.raw(["commit", "--amend", "-m", `Rewrite feature: ${content}`]);
      await seed.push(["--force", "origin", "feature"]);
    } else {
      await seed.commit(`Advance feature: ${content}`);
      await seed.push("origin", "feature");
    }
  }

  // The failure mode this guards against: the update phase treating the new
  // worktree as behind or diverged and resetting or moving it aside.
  const divergedHandling = (actions: SyncOutcomeAction[]): SyncOutcomeAction[] =>
    actions.filter(
      (action) =>
        action.kind === "preserved-diverged" ||
        (action.kind === "updated" && action.reason !== undefined && action.reason.startsWith("reset_")) ||
        (action.kind === "failed" && action.reason === "diverged_recovery_failed"),
    );

  async function expectFeatureUpToDateAfterSync(service: WorktreeSyncService): Promise<void> {
    const result = await service.sync();
    expect(result.started).toBe(true);
    if (!result.started) return;
    expect(result.outcome.counts.failed).toBe(0);
    expect(divergedHandling(result.outcome.actions)).toEqual([]);
    expect(result.outcome.actions.filter((action) => action.branch === "feature")).toEqual([
      expect.objectContaining({ kind: "noop", reason: "already_up_to_date", path: featurePath }),
    ]);
  }

  it("drops a fresh clone's non-default copies, so a rewritten branch's new worktree starts at origin's tip", async () => {
    const service = new WorktreeSyncService(makeConfig());
    await service.initialize();

    // Only the default branch keeps a local ref; every other branch is reachable through origin/* alone.
    expect(await localHeads()).toEqual(["refs/heads/main"]);
    const cloneTip = await revParse(bareRepoDir, "refs/remotes/origin/feature");
    expect(cloneTip).toBe(await revParse(remote, "refs/heads/feature"));

    // Months later the branch is rebased on the remote, then included in the sync.
    await pushFeature("v2 rewritten", { rewrite: true });
    const git = service.getGitService();
    await git.fetchAll();
    const remoteTip = await revParse(bareRepoDir, "refs/remotes/origin/feature");
    expect(remoteTip).not.toBe(cloneTip);

    await expect(git.addWorktree("feature", featurePath)).resolves.toBe(remoteTip);

    expect(await revParse(featurePath, "HEAD")).toBe(remoteTip);
    expect(await revParse(bareRepoDir, "refs/heads/feature")).toBe(remoteTip);
    expect(await upstreamOf(featurePath)).toBe("origin/feature");
    await expect(fs.readFile(path.join(featurePath, "feature.txt"), "utf8")).resolves.toBe("v2 rewritten");

    await expectFeatureUpToDateAfterSync(service);
  });

  it("moves an older bare repository's frozen copy of a branch that is only behind to origin's tip", async () => {
    const service = new WorktreeSyncService(makeConfig());
    await service.initialize();

    // A bare repository created by an older version still carries the clone-time copy.
    const cloneTip = await revParse(bareRepoDir, "refs/remotes/origin/feature");
    await simpleGit(bareRepoDir).raw(["update-ref", "refs/heads/feature", cloneTip]);

    await pushFeature("v2");
    const git = service.getGitService();
    await git.fetchAll();
    const remoteTip = await revParse(bareRepoDir, "refs/remotes/origin/feature");
    expect(remoteTip).not.toBe(cloneTip);

    await expect(git.addWorktree("feature", featurePath)).resolves.toBe(remoteTip);

    expect(await revParse(featurePath, "HEAD")).toBe(remoteTip);
    expect(await revParse(bareRepoDir, "refs/heads/feature")).toBe(remoteTip);
    expect(await upstreamOf(featurePath)).toBe("origin/feature");
    await expect(fs.readFile(path.join(featurePath, "feature.txt"), "utf8")).resolves.toBe("v2");

    await expectFeatureUpToDateAfterSync(service);
  });

  it("keeps a local branch whose commits are not on origin at its tip, and the sync reports it", async () => {
    const logger = createMockLogger();
    const service = new WorktreeSyncService(makeConfig({ logger }));
    await service.initialize();

    // A commit made in a since-removed worktree and never pushed: same tree as
    // origin/feature, so only the commit itself is local — which is also what
    // a copy whose history was rebased away on the remote looks like.
    const remoteTip = await revParse(bareRepoDir, "refs/remotes/origin/feature");
    const bare = simpleGit(bareRepoDir);
    const localOnly = (
      await bare.raw([
        "-c",
        "user.name=Test User",
        "-c",
        "user.email=test@example.com",
        "commit-tree",
        `${remoteTip}^{tree}`,
        "-p",
        remoteTip,
        "-m",
        "never pushed",
      ])
    ).trim();
    await bare.raw(["update-ref", "refs/heads/feature", localOnly]);

    const result = await service.sync();
    expect(result.started).toBe(true);
    if (!result.started) return;

    expect(await revParse(featurePath, "HEAD")).toBe(localOnly);
    expect(await revParse(bareRepoDir, "refs/heads/feature")).toBe(localOnly);
    expect(await upstreamOf(featurePath)).toBe("origin/feature");
    expect((logger as unknown as { info: Mock }).info).toHaveBeenCalledWith(
      expect.stringContaining("Local branch 'feature' has 1 commit(s) not on origin/feature"),
    );
    expect((logger as unknown as { warn: Mock }).warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `'feature': Worktree starts at ${localOnly.slice(0, 7)} while origin/feature is at ${remoteTip.slice(0, 7)}`,
      ),
    );
    expect(result.outcome.counts.failed).toBe(0);
    expect(result.outcome.actions.filter((action) => action.branch === "feature")).toEqual([
      { kind: "created", branch: "feature", path: featurePath },
      expect.objectContaining({ kind: "skipped", scope: "worktree", reason: "local_only_commits", path: featurePath }),
    ]);
  });

  it("leaves refs/heads of an existing bare repository alone", async () => {
    await new WorktreeSyncService(makeConfig()).initialize();
    const tip = await revParse(bareRepoDir, "refs/remotes/origin/feature");
    await simpleGit(bareRepoDir).raw(["update-ref", "refs/heads/feature", tip]);

    const second = new WorktreeSyncService(makeConfig());
    await second.initialize();

    expect(await localHeads()).toEqual(["refs/heads/feature", "refs/heads/main"]);
    expect(second.isInitialized()).toBe(true);
  });
});
