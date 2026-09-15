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

// Real git, no mocks. "feature/HEAD" is a branch name git accepts, and the
// only ref under refs/remotes/origin that is not a branch is the origin/HEAD
// symref. Sync used to tell them apart with endsWith("/HEAD"), so every branch
// ending in /HEAD was missing from the inventory: no worktree was ever created
// for it and — the damaging half — a worktree someone created for it through
// the TUI or MCP read as stale on the next tick and was moved to trash.
describe("Branches ending in /HEAD are real branches (E2E)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let featHeadPath: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-head-branch-")));
    remote = path.join(tempDir, "remote", "app.git");
    seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");
    featHeadPath = pathResolution.getBranchWorktreePath(worktreeDir, "feature/HEAD");

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
    await seed.raw(["push", "origin", "refs/heads/main:refs/heads/feature/HEAD"]);
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeService(): WorktreeSyncService {
    const config: RepositoryConfig = {
      name: "app",
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      logger: createMockLogger() as Logger,
      retry: { maxAttempts: 1, initialDelayMs: 0 },
      __configFileDir: tempDir,
    };
    return new WorktreeSyncService(config);
  }

  async function syncOnce(service: WorktreeSyncService): Promise<SyncOutcome> {
    const result = await service.sync();
    expect(result.started).toBe(true);
    if (!result.started) throw new Error("sync did not start");
    return result.outcome;
  }

  // `git remote set-head` writes this symref; a fresh `clone --bare` may not
  // have one, and the exclusion is only meaningful while it exists.
  async function ensureOriginHeadSymref(): Promise<void> {
    await simpleGit(bareRepoDir).raw(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  }

  async function trashEntries(): Promise<string[]> {
    return fs.readdir(path.join(worktreeDir, GIT_CONSTANTS.TRASH_DIR_NAME)).catch(() => []);
  }

  it("creates a worktree for 'feature/HEAD' and keeps it across syncs, but never one for origin/HEAD", async () => {
    const service = makeService();

    const first = await syncOnce(service);

    expect(first.counts.failed).toBe(0);
    expect(first.actions).toContainEqual({ kind: "created", branch: "feature/HEAD", path: featHeadPath });
    await expect(fs.access(path.join(featHeadPath, "README.md"))).resolves.toBeUndefined();

    await ensureOriginHeadSymref();

    const second = await syncOnce(service);

    expect(second.counts.failed).toBe(0);
    expect(second.actions.filter((action) => action.kind === "removed")).toEqual([]);
    await expect(fs.access(path.join(featHeadPath, "README.md"))).resolves.toBeUndefined();
    expect(await trashEntries()).toEqual([]);

    // The symref itself is not a branch: no worktree, no directory for it.
    const registered = await simpleGit(bareRepoDir).raw(["worktree", "list", "--porcelain"]);
    expect(registered).toContain("branch refs/heads/feature/HEAD");
    expect(registered).not.toContain("branch refs/heads/HEAD");
    expect(await fs.readdir(worktreeDir)).not.toContain(pathResolution.sanitizeBranchName("HEAD"));
  }, 60_000);

  it("keeps a worktree created outside sync for a branch ending in /HEAD", async () => {
    const service = makeService();
    await syncOnce(service);
    await ensureOriginHeadSymref();

    // What the TUI wizard and MCP create_worktree do: a new remote branch, and
    // a worktree for it that this sync has never seen. It is clean and fully
    // pushed, so nothing but the inventory stands between it and the trash.
    await simpleGit(seedDir).raw(["push", "origin", "refs/heads/main:refs/heads/release/HEAD"]);
    const releasePath = pathResolution.getBranchWorktreePath(worktreeDir, "release/HEAD");
    const bare = simpleGit(bareRepoDir);
    await bare.raw(["fetch", "origin"]);
    await bare.raw(["worktree", "add", "--track", "-b", "release/HEAD", releasePath, "origin/release/HEAD"]);

    const outcome = await syncOnce(service);

    expect(outcome.counts.failed).toBe(0);
    expect(outcome.actions.filter((action) => action.kind === "removed")).toEqual([]);
    await expect(fs.access(path.join(releasePath, "README.md"))).resolves.toBeUndefined();
    expect(await trashEntries()).toEqual([]);
  }, 60_000);
});
