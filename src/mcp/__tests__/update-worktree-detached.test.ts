import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleCreateWorktree, handleUpdateWorktree } from "../handlers";
import { formatErrorResponse } from "../utils";
import { createMockLogger } from "../../__tests__/test-utils";
import { PathResolutionService } from "../../services/path-resolution.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { RepositoryContext } from "../context";
import type { RepositoryConfig } from "../../types";
import type { CallToolResult } from "@modelcontextprotocol/server";

describe("update_worktree on a detached-HEAD worktree (real git)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let service: WorktreeSyncService;
  let ctx: RepositoryContext;

  function makeConfig(): RepositoryConfig {
    return {
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
  }

  function makeCtx(target: WorktreeSyncService): RepositoryContext {
    return {
      autoSelectCurrentRepoIfSingleConfig: () => "app",
      getDiscoveredContext: () => null,
      getBaseCapabilities: () => undefined,
      getService: async () => target,
      getEntry: () => ({ name: "app" }),
      invalidateDiscovered: () => undefined,
    } as unknown as RepositoryContext;
  }

  async function call(
    handler: (c: RepositoryContext, p: any) => Promise<CallToolResult>,
    params: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    let result: CallToolResult;
    try {
      result = await handler(ctx, params);
    } catch (err) {
      result = formatErrorResponse(err);
    }
    const [block] = result.content as Array<{ type: string; text: string }>;
    return { ...JSON.parse(block.text), isError: result.isError };
  }

  async function porcelain(): Promise<string> {
    return simpleGit(bareRepoDir).raw(["worktree", "list", "--porcelain"]);
  }

  async function headOf(dir: string): Promise<string> {
    return (await simpleGit(dir).revparse(["HEAD"])).trim();
  }

  async function advanceRemote(): Promise<string> {
    const seed = simpleGit(seedDir);
    await seed.checkout("feature/x");
    await fs.writeFile(path.join(seedDir, "second.txt"), "second");
    await seed.add(".");
    await seed.commit("Second commit");
    await seed.push("origin", "feature/x");
    return (await seed.revparse(["HEAD"])).trim();
  }

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-mcp-detached-")));
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
    await seed.checkoutLocalBranch("feature/x");
    await seed.push("origin", "feature/x");
    await simpleGit(remote).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);

    service = new WorktreeSyncService(makeConfig());
    await service.initialize();
    ctx = makeCtx(service);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("refuses with DETACHED_HEAD and fast-forwards nothing", async () => {
    const target = pathResolution.getBranchWorktreePath(worktreeDir, "feature/x");
    expect((await call(handleCreateWorktree, { branchName: "feature/x" })).success).toBe(true);
    const remoteTip = await advanceRemote();

    const detachedAt = await headOf(target);
    await simpleGit(target).raw(["checkout", "--detach", detachedAt]);
    const listing = await porcelain();
    expect(listing).toContain(`worktree ${target}`);
    expect(listing).toMatch(/^detached$/m);
    expect(listing).not.toMatch(/^branch refs\/heads\/feature\/x$/m);

    const git = service.getGitService();
    const fetchBranch = vi.spyOn(git, "fetchBranch");
    const updateWorktree = vi.spyOn(git, "updateWorktree");

    const result = await call(handleUpdateWorktree, { path: target });

    expect(result.isError).toBe(true);
    expect(result.code).toBe("DETACHED_HEAD");
    expect(result.message).toContain("detached HEAD");
    expect(result.message).toContain(target);
    expect(result.message).toContain(detachedAt);
    expect(result.message).not.toContain("not a registered worktree");

    expect(fetchBranch).not.toHaveBeenCalled();
    expect(updateWorktree).not.toHaveBeenCalled();
    expect(await headOf(target)).toBe(detachedAt);
    expect(await headOf(target)).not.toBe(remoteTip);
  });

  it("fast-forwards normally once a branch is checked out again", async () => {
    const target = pathResolution.getBranchWorktreePath(worktreeDir, "feature/x");
    expect((await call(handleCreateWorktree, { branchName: "feature/x" })).success).toBe(true);
    const remoteTip = await advanceRemote();

    await simpleGit(target).raw(["checkout", "--detach", await headOf(target)]);
    expect((await call(handleUpdateWorktree, { path: target })).code).toBe("DETACHED_HEAD");

    await simpleGit(target).raw(["checkout", "feature/x"]);
    const result = await call(handleUpdateWorktree, { path: target });

    expect(result.isError).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.updated).toBe(true);
    expect(result.worktreePath).toBe(target);
    expect(await headOf(target)).toBe(remoteTip);
  });

  it("refuses a prunable detached registration as unregistered, not as detached", async () => {
    const target = pathResolution.getBranchWorktreePath(worktreeDir, "feature/x");
    expect((await call(handleCreateWorktree, { branchName: "feature/x" })).success).toBe(true);
    await simpleGit(target).raw(["checkout", "--detach", await headOf(target)]);
    await fs.rm(target, { recursive: true, force: true });

    const listing = await porcelain();
    expect(listing).toMatch(/^detached$/m);
    expect(listing).toMatch(/^prunable /m);

    const git = service.getGitService();
    const fetchBranch = vi.spyOn(git, "fetchBranch");

    const result = await call(handleUpdateWorktree, { path: target });

    expect(result.isError).toBe(true);
    expect(result.code).not.toBe("DETACHED_HEAD");
    expect(result.message).toContain("not a registered worktree");
    expect(fetchBranch).not.toHaveBeenCalled();
  });

  it("refuses a locked detached registration whose checkout is gone as WORKTREE_MISSING", async () => {
    const target = pathResolution.getBranchWorktreePath(worktreeDir, "feature/x");
    expect((await call(handleCreateWorktree, { branchName: "feature/x" })).success).toBe(true);
    await simpleGit(target).raw(["checkout", "--detach", await headOf(target)]);
    await simpleGit(bareRepoDir).raw(["worktree", "lock", "--reason", "on removable media", target]);
    await fs.rm(target, { recursive: true, force: true });

    const listing = await porcelain();
    expect(listing).toMatch(/^detached$/m);
    expect(listing).toMatch(/^locked on removable media$/m);
    expect(listing).not.toMatch(/^prunable/m);

    const git = service.getGitService();
    const fetchBranch = vi.spyOn(git, "fetchBranch");

    const result = await call(handleUpdateWorktree, { path: target });

    expect(result.isError).toBe(true);
    expect(result.code).toBe("WORKTREE_MISSING");
    expect(fetchBranch).not.toHaveBeenCalled();
  });

  it("still answers DETACHED_HEAD for a locked detached worktree that is present", async () => {
    const target = pathResolution.getBranchWorktreePath(worktreeDir, "feature/x");
    expect((await call(handleCreateWorktree, { branchName: "feature/x" })).success).toBe(true);
    const detachedAt = await headOf(target);
    await simpleGit(target).raw(["checkout", "--detach", detachedAt]);
    await simpleGit(bareRepoDir).raw(["worktree", "lock", target]);

    const result = await call(handleUpdateWorktree, { path: target });

    expect(result.code).toBe("DETACHED_HEAD");
    expect(result.message).toContain(detachedAt);
  });

  it("still refuses the bare repository path as unregistered", async () => {
    expect((await call(handleCreateWorktree, { branchName: "feature/x" })).success).toBe(true);

    const git = service.getGitService();
    const fetchBranch = vi.spyOn(git, "fetchBranch");

    const result = await call(handleUpdateWorktree, { path: bareRepoDir });

    expect(result.isError).toBe(true);
    expect(result.message).toContain("not a registered worktree");
    expect(fetchBranch).not.toHaveBeenCalled();
  });
});
