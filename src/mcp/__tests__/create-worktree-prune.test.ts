import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleCreateWorktree } from "../handlers";
import { formatErrorResponse } from "../utils";
import { createMockLogger } from "../../__tests__/test-utils";
import { PathResolutionService } from "../../services/path-resolution.service";
import { WorktreeSyncService } from "../../services/worktree-sync.service";

import type { RepositoryContext } from "../context";
import type { RepositoryConfig } from "../../types";
import type { CallToolResult } from "@modelcontextprotocol/server";

// Real git, no mocks. This is the whole failure the guard exists for, end to
// end: create_worktree never consulted the repository's branch filters, and the
// sync planner prunes every registered worktree whose branch is missing from
// the FILTERED remote branch list. A worktree created seconds ago is clean, has
// no unpushed commits and no gone upstream, so canRemove is true and the next
// tick moves it to .trash and deletes its local branch ref — after which
// get_worktree_status and update_worktree both fail on the path the agent was
// just handed. The sync half is asserted here against real git, so the refusal
// the handler now returns is measured against what actually happens rather than
// against a description of it.
describe("create_worktree against a filtered repository (real git)", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let remote: string;
  let seedDir: string;
  let worktreeDir: string;
  let bareRepoDir: string;
  let service: WorktreeSyncService;
  let ctx: RepositoryContext;

  function makeConfig(branchInclude?: string[]): RepositoryConfig {
    return {
      name: "app",
      repoUrl: `file://${remote}`,
      worktreeDir,
      bareRepoDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      logger: createMockLogger(),
      retry: { maxAttempts: 1, initialDelayMs: 0 },
      ...(branchInclude ? { branchInclude } : {}),
      __configFileDir: tempDir,
    };
  }

  // The handler only needs a repository selection, a capability verdict and the
  // service; everything else it touches is git.
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

  async function create(params: Record<string, unknown>): Promise<Record<string, any>> {
    let result: CallToolResult;
    try {
      result = await handleCreateWorktree(ctx, params as { branchName: string });
    } catch (err) {
      result = formatErrorResponse(err);
    }
    const [block] = result.content as Array<{ type: string; text: string }>;
    return { ...JSON.parse(block.text), isError: result.isError };
  }

  async function syncOnce(): Promise<void> {
    const result = await service.sync();
    expect(result.started).toBe(true);
  }

  async function exists(target: string): Promise<boolean> {
    return fs
      .access(target)
      .then(() => true)
      .catch(() => false);
  }

  async function localBranches(): Promise<string[]> {
    const raw = await simpleGit(bareRepoDir).raw(["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    return raw.split("\n").filter(Boolean);
  }

  async function trashedDirectoryCount(): Promise<number> {
    const entries = await fs.readdir(path.join(worktreeDir, ".trash")).catch(() => [] as string[]);
    return entries.length;
  }

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-mcp-filter-")));
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
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function start(branchInclude?: string[]): Promise<void> {
    service = new WorktreeSyncService(makeConfig(branchInclude));
    await service.initialize();
    ctx = makeCtx(service);
  }

  it("refuses an excluded branch and leaves nothing on disk", async () => {
    await start(["main"]);
    const target = pathResolution.getBranchWorktreePath(worktreeDir, "feature/x");

    const body = await create({ branchName: "feature/x" });

    expect(body.isError).toBe(true);
    expect(body.code).toBe("BRANCH_FILTERED");
    expect(body.message).toContain("branchInclude");
    expect(await exists(target)).toBe(false);
    expect(await localBranches()).not.toContain("feature/x");
  });

  it("force:true creates it, and the very next sync trashes it and deletes the branch ref", async () => {
    await start(["main"]);
    const target = pathResolution.getBranchWorktreePath(worktreeDir, "feature/x");

    const body = await create({ branchName: "feature/x", force: true });
    expect(body.success).toBe(true);
    expect(body.warning).toContain("next sync");
    expect(await exists(target)).toBe(true);
    expect(await localBranches()).toContain("feature/x");

    await syncOnce();

    // Exactly what the warning promised, and what an unguarded create used to
    // do in silence: the checkout is gone and so is the branch.
    expect(await exists(target)).toBe(false);
    expect(await trashedDirectoryCount()).toBe(1);
    expect(await localBranches()).not.toContain("feature/x");
  });

  it("warns for a push:false branch, and the next sync removes it and its ref", async () => {
    await start();
    const target = pathResolution.getBranchWorktreePath(worktreeDir, "exp");

    const body = await create({ branchName: "exp", baseBranch: "main", push: false });
    expect(body.success).toBe(true);
    expect(body.pushed).toBe(false);
    expect(body.warning).toContain("next sync");
    expect(await exists(target)).toBe(true);

    await syncOnce();

    expect(await exists(target)).toBe(false);
    expect(await localBranches()).not.toContain("exp");
  });

  // Filters are configured and the branch passes them, so a guard that is
  // over-broad *within* the filter path — refusing a branch branchInclude
  // actually keeps — fails here, not only one that refuses everything.
  it("creates and pushes an included branch that the next sync then keeps", async () => {
    await start(["main", "feature/*"]);
    const target = pathResolution.getBranchWorktreePath(worktreeDir, "feature/kept");

    const body = await create({ branchName: "feature/kept", baseBranch: "main" });
    expect(body.success).toBe(true);
    expect(body.pushed).toBe(true);
    expect(body.warning).toBeUndefined();

    await syncOnce();

    expect(await exists(target)).toBe(true);
    expect(await trashedDirectoryCount()).toBe(0);
  });
});
