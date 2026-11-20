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

describe("Worktrees without an upstream (E2E)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let topicPath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-no-upstream-")));
    remote = path.join(tempDir, "remote", "app.git");
    seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
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
    await seed.push("origin", "main");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
  });

  afterEach(async () => {
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

  const originTip = async (branch: string): Promise<string> =>
    (await simpleGit(bareRepoDir).revparse([`refs/remotes/origin/${branch}`])).trim();

  const upstreamOf = async (dir: string, branch: string): Promise<string | null> =>
    simpleGit(dir)
      .raw(["config", "--get", `branch.${branch}.merge`])
      .then((out) => out.trim() || null)
      .catch(() => null);

  async function pushCommit(branch: string, content: string): Promise<string> {
    const seed = simpleGit(seedDir);
    await seed.checkout(branch);
    await fs.writeFile(path.join(seedDir, `${branch}.txt`), content);
    await seed.add(".");
    await seed.commit(`${branch} ${content}`);
    await seed.push("origin", branch);
    return (await seed.revparse([branch])).trim();
  }

  async function createTopicWithoutUpstream(service: WorktreeSyncService): Promise<string> {
    const git = service.getGitService();
    await git.fetchAll();
    expect(await git.branchExists("topic")).toEqual({ local: false, remote: false });
    await git.createBranch("topic", "main");
    await git.addWorktree("topic", topicPath);
    expect(await upstreamOf(topicPath, "topic")).toBeNull();

    await simpleGit(topicPath).push("origin", "topic");
    const seed = simpleGit(seedDir);
    await seed.fetch("origin");
    await seed.checkout(["-b", "topic", "origin/topic"]);
    return headOf(topicPath);
  }

  async function trashTopicViaPrune(service: WorktreeSyncService): Promise<string> {
    await simpleGit(seedDir).push(["origin", "--delete", "topic"]);
    const outcome = await syncOutcome(service);
    expect(actionsFor(outcome, "topic")).toEqual([
      expect.objectContaining({ kind: "removed", branch: "topic", path: topicPath }),
    ]);
    await expect(fs.access(topicPath)).rejects.toThrow();

    const { entries } = await service.listTrashEntries();
    const entry = entries.find((candidate) => candidate.manifest.branch === "topic");
    if (!entry) throw new Error("topic was not trashed");
    return entry.manifest.id;
  }

  it("fast-forwards a worktree restored from trash once its branch moves on origin", async () => {
    const service = new WorktreeSyncService(makeConfig());
    await service.initialize();
    await syncOutcome(service);
    const v1 = await createTopicWithoutUpstream(service);
    expect(actionsFor(await syncOutcome(service), "topic")).toEqual([
      expect.objectContaining({ kind: "noop", reason: "already_up_to_date", path: topicPath }),
    ]);

    const trashId = await trashTopicViaPrune(service);
    await simpleGit(seedDir).push("origin", "topic");
    const manifest = await service.restoreFromTrash(trashId);
    expect(manifest.originalPath).toBe(topicPath);
    expect(await headOf(topicPath)).toBe(v1);
    expect(await upstreamOf(topicPath, "topic")).toBeNull();

    const v2 = await pushCommit("topic", "v2");
    const outcome = await syncOutcome(service);

    expect(actionsFor(outcome, "topic")).toEqual([
      { kind: "updated", branch: "topic", path: topicPath, reason: "fast_forward" },
    ]);
    expect(await headOf(topicPath)).toBe(v2);
    expect(await headOf(topicPath)).toBe(await originTip("topic"));
    await expect(fs.readFile(path.join(topicPath, "topic.txt"), "utf8")).resolves.toBe("v2");

    expect(await upstreamOf(topicPath, "topic")).toBeNull();
    expect(actionsFor(await syncOutcome(service), "topic")).toEqual([
      expect.objectContaining({ kind: "noop", reason: "already_up_to_date", path: topicPath }),
    ]);
  });

  it("gives a restored worktree an upstream when origin/<branch> is already known", async () => {
    const logger = createMockLogger();
    const service = new WorktreeSyncService(makeConfig(logger));
    await service.initialize();
    await syncOutcome(service);
    await createTopicWithoutUpstream(service);
    await syncOutcome(service);

    const trashId = await trashTopicViaPrune(service);
    await simpleGit(seedDir).push("origin", "topic");
    await simpleGit(bareRepoDir).fetch(["--all", "--prune"]);

    await service.restoreFromTrash(trashId);

    expect(await upstreamOf(topicPath, "topic")).toBe("refs/heads/topic");
    expect(infoLines(logger)).toContain("  - Set upstream of 'topic' to origin/topic");
    const status = await simpleGit(topicPath).status();
    expect(status.tracking).toBe("origin/topic");
    expect(status.isClean()).toBe(true);

    const v2 = await pushCommit("topic", "v2");
    const outcome = await syncOutcome(service);
    expect(actionsFor(outcome, "topic")).toEqual([
      { kind: "updated", branch: "topic", path: topicPath, reason: "fast_forward" },
    ]);
    expect(await headOf(topicPath)).toBe(v2);
  });

  it("fast-forwards a worktree created without a push once its published branch moves", async () => {
    const service = new WorktreeSyncService(makeConfig());
    await service.initialize();
    await syncOutcome(service);
    const v1 = await createTopicWithoutUpstream(service);

    const v2 = await pushCommit("topic", "v2");
    expect(v2).not.toBe(v1);
    const outcome = await syncOutcome(service);

    expect(actionsFor(outcome, "topic")).toEqual([
      { kind: "updated", branch: "topic", path: topicPath, reason: "fast_forward" },
    ]);
    expect(await headOf(topicPath)).toBe(v2);
    expect(await headOf(topicPath)).toBe(await originTip("topic"));
    expect(await upstreamOf(topicPath, "topic")).toBeNull();
  });
});
