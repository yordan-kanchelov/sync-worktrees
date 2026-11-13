import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RepositoryContext } from "../context";
import { handleCreateWorktree, handleDetectContext, handleListWorktrees, handleUpdateWorktree } from "../handlers";
import { formatErrorResponse } from "../utils";
import { createMockLogger } from "../../__tests__/test-utils";
import { PathResolutionService } from "../../services/path-resolution.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { RepositoryConfig } from "../../types";
import type { CallToolResult } from "@modelcontextprotocol/server";

// Real git: stale (directory deleted), locked and detached registrations as
// list_worktrees, detect_context { includeStatus } and update_worktree see them.
describe("stale, locked and detached worktrees (real git)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let remote: string;
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
      getConfiguredRepositoryNames: () => [],
      getDiscoveredContext: () => null,
      getBaseCapabilities: () => undefined,
      getService: async () => target,
      getEntry: () => ({ name: "app" }),
      getCurrentRepo: () => "app",
      getLaunchCwd: () => tempDir,
      invalidateDiscovered: () => undefined,
    } as unknown as RepositoryContext;
  }

  async function call(
    handler: (c: RepositoryContext, p: any) => Promise<CallToolResult>,
    params: Record<string, unknown>,
    target: RepositoryContext = ctx,
  ): Promise<Record<string, any>> {
    let result: CallToolResult;
    try {
      result = await handler(target, params);
    } catch (err) {
      result = formatErrorResponse(err);
    }
    const [block] = result.content as Array<{ type: string; text: string }>;
    return { ...JSON.parse(block.text), isError: result.isError };
  }

  async function create(branch: string): Promise<string> {
    expect((await call(handleCreateWorktree, { branchName: branch })).success).toBe(true);
    return pathResolution.getBranchWorktreePath(worktreeDir, branch);
  }

  async function listed(target: string): Promise<Record<string, any> | undefined> {
    const result = await call(handleListWorktrees, {});
    return (result.worktrees as Array<Record<string, any>>).find((w) => w.path === target);
  }

  async function detected(target: string): Promise<Record<string, any> | undefined> {
    const mainPath = pathResolution.getBranchWorktreePath(worktreeDir, "main");
    const result = await call(handleDetectContext, { path: mainPath, includeStatus: true }, new RepositoryContext());
    return (result.allWorktrees as Array<Record<string, any>>).find((w) => w.path === target);
  }

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-mcp-shapes-")));
    remote = path.join(tempDir, "remote", "app.git");
    const seedDir = path.join(tempDir, "seed");
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

  describe("stale registration (directory deleted)", () => {
    it("list_worktrees reports unknown, no status, not safe to remove", async () => {
      const target = await create("feature/x");
      await fs.rm(target, { recursive: true, force: true });

      const entry = await listed(target);
      expect(entry).toBeDefined();
      expect(entry!.status).toBeNull();
      expect(entry!.label).toBe("unknown");
      expect(entry!.safeToRemove.safe).toBe(false);
      expect(entry!.safeToRemove.reason).toMatch(/missing/);
    });

    it("detect_context { includeStatus } reports unknown with the reason", async () => {
      const target = await create("feature/x");
      await fs.rm(target, { recursive: true, force: true });

      const entry = await detected(target);
      expect(entry).toBeDefined();
      expect(entry!.label).toBe("unknown");
      expect(entry!.prunable).toBe(true);
      expect(entry!.statusError).toMatch(/missing/);
    });

    it("update_worktree answers WORKTREE_MISSING", async () => {
      const target = await create("feature/x");
      await fs.rm(target, { recursive: true, force: true });
      const fetchBranch = vi.spyOn(service.getGitService(), "fetchBranch");

      const result = await call(handleUpdateWorktree, { path: target });

      expect(result.isError).toBe(true);
      expect(result.code).toBe("WORKTREE_MISSING");
      expect(result.message).toContain(target);
      expect(fetchBranch).not.toHaveBeenCalled();
    });

    // Git does not mark a locked registration prunable, so nothing in the
    // listing says the directory is gone; this used to reach `spawn git ENOENT`.
    it("update_worktree answers WORKTREE_MISSING for a locked one too", async () => {
      const target = await create("feature/x");
      await simpleGit(bareRepoDir).raw(["worktree", "lock", target]);
      await fs.rm(target, { recursive: true, force: true });

      const result = await call(handleUpdateWorktree, { path: target });

      expect(result.isError).toBe(true);
      expect(result.code).toBe("WORKTREE_MISSING");
      expect(result.message).not.toContain("ENOENT");
    });
  });

  describe("locked worktree", () => {
    it("list_worktrees reports it as not safe to remove, with the lock reason", async () => {
      const target = await create("feature/x");
      await simpleGit(bareRepoDir).raw(["worktree", "lock", "--reason", "on usb", target]);

      const entry = await listed(target);
      expect(entry).toBeDefined();
      expect(entry!.locked).toBe(true);
      expect(entry!.safeToRemove).toEqual({ safe: false, reason: "worktree is locked: on usb" });
    });

    it("list_worktrees names a lock without a reason", async () => {
      const target = await create("feature/x");
      await simpleGit(bareRepoDir).raw(["worktree", "lock", target]);

      expect((await listed(target))!.safeToRemove).toEqual({ safe: false, reason: "worktree is locked" });
    });

    it("detect_context { includeStatus } flags it as locked", async () => {
      const target = await create("feature/x");
      await simpleGit(bareRepoDir).raw(["worktree", "lock", target]);

      const entry = await detected(target);
      expect(entry).toBeDefined();
      expect(entry!.locked).toBe(true);
    });

    it("update_worktree still fast-forwards a present locked worktree", async () => {
      const target = await create("feature/x");
      await simpleGit(bareRepoDir).raw(["worktree", "lock", target]);

      const result = await call(handleUpdateWorktree, { path: target });
      expect(result.isError).toBeUndefined();
      expect(result.success).toBe(true);
    });
  });

  describe("detached worktree", () => {
    async function detach(target: string): Promise<string> {
      const head = (await simpleGit(target).revparse(["HEAD"])).trim();
      await simpleGit(target).raw(["checkout", "--detach", head]);
      return head;
    }

    it("list_worktrees lists it, not safe to remove", async () => {
      const target = await create("feature/x");
      const head = await detach(target);

      const entry = await listed(target);
      expect(entry).toBeDefined();
      expect(entry!.detached).toBe(true);
      expect(entry!.branch).toBe(`(detached ${head.slice(0, 7)})`);
      expect(entry!.safeToRemove).toEqual({ safe: false, reason: "detached HEAD" });
    });

    it("detect_context { includeStatus } lists it and flags it as detached", async () => {
      const target = await create("feature/x");
      await detach(target);

      const entry = await detected(target);
      expect(entry).toBeDefined();
      expect(entry!.detached).toBe(true);
      expect(entry!.label).toBeDefined();
    });

    it("update_worktree answers DETACHED_HEAD", async () => {
      const target = await create("feature/x");
      await detach(target);

      const result = await call(handleUpdateWorktree, { path: target });
      expect(result.code).toBe("DETACHED_HEAD");
    });
  });
});
