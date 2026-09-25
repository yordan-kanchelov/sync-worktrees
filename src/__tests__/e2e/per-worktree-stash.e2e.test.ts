import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PathResolutionService } from "../../services/path-resolution.service";
import { WorktreeStatusService } from "../../services/worktree-status.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { createMockLogger } from "../test-utils";

import type { Logger } from "../../services/logger.service";
import type { RepositoryConfig, SyncOutcome } from "../../types";

// Real git, no mocks. refs/stash lives in the repository's common dir, so
// `git stash list` run in any worktree lists the stashes made in every
// worktree. Counting that list as-is made one stash anywhere report "stashed
// changes" for every worktree: no prune could pass the safety gate, every
// diverged replace was skipped, and MCP labelled every worktree dirty.
describe("Stashes are attributed to the worktree they were made in (E2E)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let remote: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let mainPath: string;
  let featAPath: string;
  let featBPath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-stash-")));
    remote = path.join(tempDir, "remote", "app.git");
    const seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    // The default branch sits at its plain name, every other branch at the
    // sanitized+hashed one.
    mainPath = path.join(worktreeDir, "main");
    featAPath = pathResolution.getBranchWorktreePath(worktreeDir, "feature/a");
    featBPath = pathResolution.getBranchWorktreePath(worktreeDir, "feature/b");

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
    // Both feature branches carry no commits of their own, so each stays fully
    // pushed once its remote branch is gone and only a stash can block it.
    await seed.push("origin", "main:refs/heads/feature/a");
    await seed.push("origin", "main:refs/heads/feature/b");
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

  async function stashAChange(worktreePath: string, message?: string): Promise<void> {
    const git = simpleGit(worktreePath);
    await fs.appendFile(path.join(worktreePath, "README.md"), `change in ${path.basename(worktreePath)}\n`);
    await git.raw(message ? ["stash", "push", "-m", message] : ["stash", "push"]);
  }

  async function setUpWorktrees(): Promise<WorktreeSyncService> {
    const service = new WorktreeSyncService(makeConfig(createMockLogger()));
    const first = await syncOnce(service);
    expect(first.counts.failed).toBe(0);
    // Stashing needs an identity; the config is shared by every worktree.
    await simpleGit(mainPath).addConfig("user.name", "Test User");
    await simpleGit(mainPath).addConfig("user.email", "test@example.com");
    return service;
  }

  it("reports a stash only for the worktree it was made in", async () => {
    await setUpWorktrees();
    await stashAChange(mainPath);
    await stashAChange(featBPath, "wip: colons in: the message");

    // Precondition: git itself lists both stashes from every worktree.
    expect((await simpleGit(featAPath).stashList()).total).toBe(2);

    const status = new WorktreeStatusService({}, createMockLogger());
    const [main, featA, featB] = await Promise.all(
      [mainPath, featAPath, featBPath].map((p) => status.getFullWorktreeStatus(p, true)),
    );

    expect(main.hasStashedChanges).toBe(true);
    expect(main.details?.stashCount).toBe(1);
    expect(featA.hasStashedChanges).toBe(false);
    expect(featA.details?.stashCount).toBe(0);
    expect(featA.reasons).not.toContain("stashed changes");
    expect(featB.hasStashedChanges).toBe(true);
    expect(featB.details?.stashCount).toBe(1);

    await expect(status.hasStashedChanges(mainPath)).resolves.toBe(true);
    await expect(status.hasStashedChanges(featAPath)).resolves.toBe(false);
    await expect(status.hasStashedChanges(featBPath)).resolves.toBe(true);
  }, 60_000);

  it("attributes a detached-HEAD stash by the commit it was made on", async () => {
    await setUpWorktrees();
    const main = simpleGit(mainPath);
    // A commit feature/a does not have, stashed on while detached, then main
    // is checked out again at that same commit.
    await fs.writeFile(path.join(mainPath, "local.txt"), "local\n");
    await main.add("local.txt");
    await main.commit("Local-only commit");
    await main.raw(["checkout", "--detach"]);
    await stashAChange(mainPath);
    await main.raw(["checkout", "main"]);
    expect((await main.stashList()).latest?.message).toMatch(/^WIP on \(no branch\):/);

    const status = new WorktreeStatusService({}, createMockLogger());

    await expect(status.hasStashedChanges(mainPath)).resolves.toBe(true);
    await expect(status.hasStashedChanges(featAPath)).resolves.toBe(false);
  }, 60_000);

  it("prunes a clean worktree while another worktree holds a stash, and keeps the stashed one", async () => {
    const service = await setUpWorktrees();
    await stashAChange(mainPath);
    await stashAChange(featBPath);

    await simpleGit(remote).raw(["branch", "-D", "feature/a"]);
    await simpleGit(remote).raw(["branch", "-D", "feature/b"]);

    const second = await syncOnce(service);

    expect(second.actions).toContainEqual({ kind: "removed", branch: "feature/a", path: featAPath });
    await expect(fs.access(featAPath)).rejects.toThrow();
    expect(second.actions).not.toContainEqual(expect.objectContaining({ kind: "removed", branch: "feature/b" }));
    await expect(fs.access(featBPath)).resolves.toBeUndefined();
  }, 60_000);
});
