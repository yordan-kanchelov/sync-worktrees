import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorktreeSyncService } from "../../services/worktree-sync.service";
import { createMockLogger } from "../test-utils";

import type { Logger } from "../../services/logger.service";
import type { RepositoryConfig, SyncOutcome } from "../../types";
import type { Mock } from "vitest";

// Real git, no mocks. The default branch's worktree is matched by path, and
// the planner never plans the default branch, so a checkout at that path that
// is detached or on another branch used to be adopted silently: the sync
// reported a clean run while the default branch's worktree fell behind.
describe("Default-branch worktree not on the default branch (E2E)", () => {
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let mainPath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-anchor-state-")));
    remote = path.join(tempDir, "remote", "app.git");
    seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    mainPath = path.join(worktreeDir, "main");

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

  async function pushToMain(): Promise<string> {
    const seed = simpleGit(seedDir);
    await fs.writeFile(path.join(seedDir, "next.txt"), "next");
    await seed.add(".");
    await seed.commit("Next on main");
    await seed.push("origin", "main");
    return (await seed.revparse(["HEAD"])).trim();
  }

  const headOf = async (dir: string): Promise<string> => (await simpleGit(dir).revparse(["HEAD"])).trim();

  const warnings = (logger: Logger): string[] => (logger.warn as Mock).mock.calls.map((call) => String(call[0]));

  it("reports a detached default-branch worktree as a skip instead of a clean sync", async () => {
    const logger = createMockLogger();
    const service = new WorktreeSyncService(makeConfig(logger));
    expect((await syncOnce(service)).counts.skipped).toBe(0);

    await simpleGit(mainPath).raw(["checkout", "--detach"]);
    const detachedHead = await headOf(mainPath);
    await pushToMain();

    const second = await syncOnce(service);
    expect(second.counts.failed).toBe(0);
    expect(second.counts.skipped).toBeGreaterThan(0);
    expect(second.actions).toContainEqual(
      expect.objectContaining({ kind: "skipped", reason: "default_branch_detached", branch: "main", path: mainPath }),
    );
    expect(warnings(logger).some((line) => line.includes(mainPath) && line.includes("detached"))).toBe(true);
    // Left alone: the user's checkout is not moved.
    expect(await headOf(mainPath)).toBe(detachedHead);

    // A fresh process (initialize() adopts the anchor) reports it too.
    const fresh = await syncOnce(new WorktreeSyncService(makeConfig(createMockLogger())));
    expect(fresh.actions).toContainEqual(
      expect.objectContaining({ kind: "skipped", reason: "default_branch_detached", branch: "main", path: mainPath }),
    );
  });

  it("reports a default-branch worktree on another branch as a skip and never prunes it", async () => {
    const logger = createMockLogger();
    const service = new WorktreeSyncService(makeConfig(logger));
    await syncOnce(service);

    // A local branch origin does not have: an ordinary worktree on it would be
    // a prune candidate, but this one is where every fetch runs.
    await simpleGit(mainPath).raw(["switch", "-c", "local-only"]);
    await pushToMain();

    const second = await syncOnce(service);
    expect(second.counts.failed).toBe(0);
    expect(second.actions).toContainEqual(
      expect.objectContaining({ kind: "skipped", reason: "default_branch_mismatch", branch: "main", path: mainPath }),
    );
    expect(second.actions.filter((action) => action.kind === "removed")).toEqual([]);
    expect(warnings(logger).some((line) => line.includes(mainPath) && line.includes("local-only"))).toBe(true);
    await expect(fs.access(path.join(mainPath, "README.md"))).resolves.toBeUndefined();
    expect((await simpleGit(mainPath).raw(["branch", "--show-current"])).trim()).toBe("local-only");

    // A dry run plans the same skip and no removal of the anchor.
    const dryRun = await new WorktreeSyncService(makeConfig(createMockLogger())).planSync();
    if (!dryRun.started) throw new Error("dry run did not start");
    expect(dryRun.plan.steps).toContainEqual(
      expect.objectContaining({ kind: "skip", reason: "default_branch_mismatch", branch: "main", path: mainPath }),
    );
    expect(dryRun.plan.steps.filter((step) => step.kind === "remove")).toEqual([]);

    // And the next sync still runs from it.
    const third = await syncOnce(service);
    expect(third.counts.failed).toBe(0);
    expect(third.actions).toContainEqual(
      expect.objectContaining({ kind: "skipped", reason: "default_branch_mismatch", branch: "main" }),
    );
  });

  it("records no skip while the default-branch worktree is on the default branch", async () => {
    const service = new WorktreeSyncService(makeConfig(createMockLogger()));
    await syncOnce(service);
    const tip = await pushToMain();

    const second = await syncOnce(service);
    expect(second.counts.skipped).toBe(0);
    expect(await headOf(mainPath)).toBe(tip);
  });
});
