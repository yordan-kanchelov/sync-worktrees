import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PathResolutionService } from "../../services/path-resolution.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { createMockLogger } from "../test-utils";

import type { GitService } from "../../services/git.service";
import type { Logger } from "../../services/logger.service";
import type { RepositoryConfig, SyncOutcome, SyncOutcomeAction } from "../../types";
import type { SyncMetadata } from "../../types/sync-metadata";
import type { Mock } from "vitest";

describe("Worktrees whose branch tracks a different upstream (E2E)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let mainPath: string;
  let topicPath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-foreign-upstream-")));
    remote = path.join(tempDir, "remote", "app.git");
    seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    mainPath = path.join(worktreeDir, "main");
    topicPath = pathResolution.getBranchWorktreePath(worktreeDir, "topic");

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
    await seed.push(["-u", "origin", "main"]);
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeConfig(logger: Logger = createMockLogger()): RepositoryConfig {
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

  async function syncOutcome(service: WorktreeSyncService): Promise<SyncOutcome> {
    const result = await service.sync();
    expect(result.started).toBe(true);
    if (!result.started) throw new Error("sync did not start");
    expect(result.outcome.counts.failed).toBe(0);
    return result.outcome;
  }

  const actionsFor = (outcome: SyncOutcome, branch: string): SyncOutcomeAction[] =>
    outcome.actions.filter((action) => action.branch === branch);

  const infoLines = (logger: Logger): string[] => (logger.info as Mock).mock.calls.map((call) => String(call[0]));

  const headOf = async (dir: string): Promise<string> => (await simpleGit(dir).revparse(["HEAD"])).trim();

  const upstreamOf = async (dir: string, branch: string): Promise<string | null> =>
    simpleGit(dir)
      .raw(["config", "--get", `branch.${branch}.merge`])
      .then((out) => out.trim() || null)
      .catch(() => null);

  async function syncFieldsOf(
    git: GitService,
    dir: string,
  ): Promise<Pick<SyncMetadata, "lastSyncCommit" | "lastSyncDate">> {
    const metadata = await git.getWorktreeMetadata(dir);
    if (!metadata) throw new Error(`no sync metadata for ${dir}`);
    const { lastSyncCommit, lastSyncDate } = metadata;
    return { lastSyncCommit, lastSyncDate };
  }

  async function pushCommit(branch: string, content: string): Promise<string> {
    const seed = simpleGit(seedDir);
    await seed.checkout(branch);
    await fs.writeFile(path.join(seedDir, `${branch}.txt`), content);
    await seed.add(".");
    await seed.commit(`${branch} ${content}`);
    await seed.push("origin", branch);
    return (await seed.revparse([branch])).trim();
  }

  async function publishBranch(branch: string): Promise<string> {
    const seed = simpleGit(seedDir);
    await seed.checkout("main");
    await seed.checkoutLocalBranch(branch);
    await fs.writeFile(path.join(seedDir, `${branch}.txt`), "v1");
    await seed.add(".");
    await seed.commit(`${branch} v1`);
    await seed.push(["-u", "origin", branch]);
    return (await seed.revparse([branch])).trim();
  }

  it("records no update and leaves the sync metadata alone while main moves on", async () => {
    const logger = createMockLogger();
    const service = new WorktreeSyncService(makeConfig(logger));
    const git = service.getGitService();
    await service.initialize();
    await syncOutcome(service);

    const topicV1 = await publishBranch("topic");
    expect(actionsFor(await syncOutcome(service), "topic")).toEqual([
      { kind: "created", branch: "topic", path: topicPath },
    ]);
    expect(await headOf(topicPath)).toBe(topicV1);
    expect(await upstreamOf(topicPath, "topic")).toBe("refs/heads/topic");

    await simpleGit(topicPath).raw(["branch", "-u", "origin/main"]);
    expect(await upstreamOf(topicPath, "topic")).toBe("refs/heads/main");
    const before = await syncFieldsOf(git, topicPath);
    expect(before.lastSyncCommit).toBe(topicV1);

    const mainV2 = await pushCommit("main", "v2");

    const first = await syncOutcome(service);
    expect(actionsFor(first, "main")).toEqual([
      { kind: "updated", branch: "main", path: mainPath, reason: "fast_forward" },
    ]);
    expect(await headOf(mainPath)).toBe(mainV2);
    expect(actionsFor(first, "topic")).toEqual([
      expect.objectContaining({ kind: "noop", reason: "already_up_to_date", path: topicPath }),
    ]);
    expect(actionsFor(await syncOutcome(service), "topic")).toEqual([
      expect.objectContaining({ kind: "noop", reason: "already_up_to_date", path: topicPath }),
    ]);

    expect(await headOf(topicPath)).toBe(topicV1);
    expect(await syncFieldsOf(git, topicPath)).toEqual(before);
    const lines = infoLines(logger);
    expect(lines).not.toContain("  - Updating worktree 'topic'...");
    expect(lines).not.toContain("    ✅ Successfully updated 'topic'.");

    const topicV2 = await pushCommit("topic", "v2");
    const outcome = await syncOutcome(service);
    expect(actionsFor(outcome, "topic")).toEqual([
      { kind: "updated", branch: "topic", path: topicPath, reason: "fast_forward" },
    ]);
    expect(await headOf(topicPath)).toBe(topicV2);
    const after = await syncFieldsOf(git, topicPath);
    expect(after.lastSyncCommit).toBe(topicV2);
    expect(after.lastSyncDate).not.toBe(before.lastSyncDate);
    expect(await upstreamOf(topicPath, "topic")).toBe("refs/heads/main");
  });

  it("records already_up_to_date, not an update, when HEAD reaches the remote tip between the probe and the fast-forward", async () => {
    const logger = createMockLogger();
    const service = new WorktreeSyncService(makeConfig(logger));
    const git = service.getGitService();
    await service.initialize();
    await syncOutcome(service);
    await publishBranch("topic");
    await syncOutcome(service);
    const before = await syncFieldsOf(git, topicPath);

    const topicV2 = await pushCommit("topic", "v2");
    const probe = git.getAheadBehindCounts.bind(git);
    let probeSaidBehind: boolean | undefined;
    const spy = vi.spyOn(git, "getAheadBehindCounts").mockImplementation(async (worktreePath, branch) => {
      const counts = await probe(worktreePath, branch);
      if (branch === "topic") {
        probeSaidBehind = counts.behind > 0;
        await simpleGit(topicPath).merge(["origin/topic", "--ff-only"]);
      }
      return counts;
    });

    const outcome = await syncOutcome(service);

    expect(spy).toHaveBeenCalledWith(topicPath, "topic");
    expect(probeSaidBehind).toBe(true);
    const lines = infoLines(logger);
    expect(lines).toContain("  - Updating worktree 'topic'...");
    expect(lines).not.toContain("    ✅ Successfully updated 'topic'.");
    expect(lines).toContain("    ℹ️  'topic' was already up to date; nothing to fast-forward.");
    expect(actionsFor(outcome, "topic")).toEqual([
      { kind: "noop", scope: "worktree", reason: "already_up_to_date", branch: "topic", path: topicPath },
    ]);
    expect(outcome.counts.updated).toBe(0);
    expect(await headOf(topicPath)).toBe(topicV2);
    expect(await syncFieldsOf(git, topicPath)).toEqual(before);

    spy.mockRestore();
    expect(actionsFor(await syncOutcome(service), "topic")).toEqual([
      expect.objectContaining({ kind: "noop", reason: "already_up_to_date", path: topicPath }),
    ]);
    expect(await syncFieldsOf(git, topicPath)).toEqual(before);
  });
});
