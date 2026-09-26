import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { METADATA_CONSTANTS } from "../../constants";
import { PathResolutionService } from "../path-resolution.service";
import { WorktreeSyncService } from "../worktree-sync.service";

import type { RepositoryConfig } from "../../types";

// Real git. New worktrees get the plain directory name (`feature/x` ->
// `feature-x`) unless something would share it; worktrees created with the
// older hashed names stay where they are.
describe("worktree directory naming (real git)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let service: WorktreeSyncService;

  const hashed = (branch: string): string => path.join(worktreeDir, pathResolution.sanitizeBranchName(branch));

  async function pushBranch(branch: string): Promise<void> {
    await simpleGit(seedDir).push("origin", `main:refs/heads/${branch}`);
    await service.getGitService().fetchAll();
  }

  async function registered(): Promise<Array<{ path: string; branch: string }>> {
    return (await service.getWorktrees()).map((w) => ({ path: path.resolve(w.path), branch: w.branch }));
  }

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-naming-")));
    remote = path.join(tempDir, "remote", "app.git");
    seedDir = path.join(tempDir, "seed");
    worktreeDir = path.join(tempDir, "worktrees");
    bareRepoDir = path.join(tempDir, ".bare", "app");

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

    const config: RepositoryConfig = {
      name: "app",
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      logger: createMockLogger(),
      retry: { maxAttempts: 1, initialDelayMs: 0 },
      __configFileDir: tempDir,
    };
    service = new WorktreeSyncService(config);
    await service.initialize();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("GitService.resolveNewWorktreePath", () => {
    it("uses the plain name when nothing else would share it", async () => {
      await pushBranch("feature/x");
      expect(await service.getGitService().resolveNewWorktreePath("feature/x")).toBe(
        path.join(worktreeDir, "feature-x"),
      );
    });

    it("hashes a branch another origin branch flattens onto (slash vs dash)", async () => {
      await pushBranch("feature/x");
      await pushBranch("feature-x");
      expect(await service.getGitService().resolveNewWorktreePath("feature/x")).toBe(hashed("feature/x"));
      expect(await service.getGitService().resolveNewWorktreePath("feature-x")).toBe(hashed("feature-x"));
    });

    it("hashes a branch whose plain name differs from another branch's only in case", async () => {
      await pushBranch("Docs");
      await pushBranch("docs");
      expect(await service.getGitService().resolveNewWorktreePath("docs")).toBe(hashed("docs"));
    });

    it("hashes a branch the default branch's directory name would otherwise go to", async () => {
      await pushBranch("MAIN");
      expect(await service.getGitService().resolveNewWorktreePath("MAIN")).toBe(hashed("MAIN"));
    });

    it("answers with the branch's existing registration, hashed or not", async () => {
      await pushBranch("feature/x");
      await service.getGitService().addWorktree("feature/x", hashed("feature/x"));
      expect(await service.getGitService().resolveNewWorktreePath("feature/x")).toBe(hashed("feature/x"));
    });

    it("never hands a name to a branch while another branch's metadata record is left under it", async () => {
      await pushBranch("feature/x");
      const record = path.join(
        bareRepoDir,
        METADATA_CONSTANTS.WORKTREE_METADATA_PATH,
        "feature-x",
        METADATA_CONSTANTS.METADATA_FILENAME,
      );
      await fs.mkdir(path.dirname(record), { recursive: true });
      await fs.writeFile(
        record,
        JSON.stringify({
          lastSyncCommit: "abc123",
          lastSyncDate: new Date().toISOString(),
          upstreamBranch: "origin/feature-x",
          createdFrom: { branch: "main", commit: "abc123" },
          syncHistory: [],
        }),
      );

      expect(await service.getGitService().resolveNewWorktreePath("feature/x")).toBe(hashed("feature/x"));
    });
  });

  describe("sync", () => {
    it("keeps existing hashed worktrees in place and gives new branches plain names", async () => {
      await pushBranch("feature/old");
      await service.getGitService().addWorktree("feature/old", hashed("feature/old"));
      await pushBranch("feature/new");

      const result = await service.sync();
      expect(result.started && result.outcome.counts.failed).toBe(0);

      const worktrees = await registered();
      expect(worktrees).toContainEqual({ path: hashed("feature/old"), branch: "feature/old" });
      expect(worktrees).toContainEqual({ path: path.join(worktreeDir, "feature-new"), branch: "feature/new" });
      expect(worktrees.filter((w) => w.branch === "feature/old")).toHaveLength(1);
      // Metadata is keyed by directory name; both kinds carry their own record.
      expect(await service.getGitService().getWorktreeMetadata(hashed("feature/old"))).toMatchObject({
        upstreamBranch: "origin/feature/old",
      });
      expect(await service.getGitService().getWorktreeMetadata(path.join(worktreeDir, "feature-new"))).toMatchObject({
        upstreamBranch: "origin/feature/new",
      });
    });

    it("hashes both branches of a slash/dash pair and never overwrites one's metadata with the other's", async () => {
      await pushBranch("feature/x");
      await pushBranch("feature-x");

      const result = await service.sync();
      expect(result.started && result.outcome.counts.failed).toBe(0);

      const worktrees = await registered();
      expect(worktrees).toContainEqual({ path: hashed("feature/x"), branch: "feature/x" });
      expect(worktrees).toContainEqual({ path: hashed("feature-x"), branch: "feature-x" });
      await expect(fs.access(path.join(worktreeDir, "feature-x"))).rejects.toThrow();
    });
  });
});
