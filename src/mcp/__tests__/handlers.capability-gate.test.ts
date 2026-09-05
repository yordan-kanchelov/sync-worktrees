import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RepositoryContext } from "../context";
import { handleCreateWorktree, handleInitialize, handleSync, handleUpdateWorktree } from "../handlers";
import { formatErrorResponse } from "../utils";

import type { CallToolResult } from "@modelcontextprotocol/server";

// These tests drive the real RepositoryContext against a temporary worktree
// fixture. Only git and WorktreeSyncService are mocked, so the capability gate
// is exercised end to end without touching a real repository.

const mockRemoteUrl = vi.fn<any>();
const mockWorktreeList = vi.fn<any>();
const mockServiceFactory = vi.fn<any>();

vi.mock("simple-git", () => ({
  default: vi.fn((basePath?: string) => ({
    remote: (...args: unknown[]) => (mockRemoteUrl as any)(...args),
    raw: (...args: unknown[]) => (mockWorktreeList as any)(basePath, ...args),
  })),
}));

vi.mock("../../services/worktree-sync.service", () => ({
  WorktreeSyncService: vi.fn().mockImplementation(function (config: unknown) {
    return (mockServiceFactory as any)(config);
  }),
}));

async function invoke<T>(
  handler: (ctx: RepositoryContext, params: T) => Promise<CallToolResult>,
  ctx: RepositoryContext,
  params: T,
): Promise<CallToolResult> {
  try {
    return await handler(ctx, params);
  } catch (err) {
    return formatErrorResponse(err);
  }
}

function parseResponse(result: any): any {
  return JSON.parse(result.content[0].text);
}

async function makeWorktreeFixture(): Promise<{
  root: string;
  bareRepo: string;
  worktreesDir: string;
  currentWorktree: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-gate-"));
  const bareRepo = path.join(root, ".bare", "repo");
  const gitInternal = path.join(bareRepo, "worktrees", "feature-x");
  await fs.mkdir(gitInternal, { recursive: true });

  const worktreesDir = path.join(root, "worktrees");
  const currentWorktree = path.join(worktreesDir, "feature-x");
  await fs.mkdir(currentWorktree, { recursive: true });

  await fs.writeFile(path.join(currentWorktree, ".git"), `gitdir: ${gitInternal}\n`, "utf-8");

  return {
    root,
    bareRepo,
    worktreesDir,
    currentWorktree,
    cleanup: async (): Promise<void> => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function makeService(): { service: Record<string, any>; git: Record<string, any> } {
  const git = {
    fetchAll: vi.fn<any>().mockResolvedValue(undefined),
    fetchBranch: vi.fn<any>().mockResolvedValue(undefined),
    getWorktrees: vi.fn<any>().mockResolvedValue([]),
    branchExists: vi.fn<any>().mockResolvedValue({ local: true, remote: true }),
    createBranch: vi.fn<any>().mockResolvedValue(undefined),
    pushBranch: vi.fn<any>().mockResolvedValue(undefined),
    addWorktree: vi.fn<any>().mockResolvedValue(undefined),
    updateWorktree: vi.fn<any>().mockResolvedValue(undefined),
  };
  const service = {
    config: {} as Record<string, unknown>,
    isInitialized: () => true,
    isSyncInProgress: () => false,
    isCloneMode: () => false,
    initialize: vi.fn<any>().mockResolvedValue(undefined),
    initializeUnlocked: vi.fn<any>().mockResolvedValue(undefined),
    runExclusiveRepoOperation: vi.fn<any>().mockImplementation(async (operation: unknown) => ({
      started: true,
      value: await (operation as () => Promise<unknown>)(),
    })),
    sync: vi.fn<any>().mockResolvedValue({ started: true }),
    getGitService: () => git,
    getDefaultBranch: vi.fn<any>().mockResolvedValue("main"),
    getRecordedSkips: () => [],
    clearPendingInitSkip: vi.fn<any>(),
  };
  return { service, git };
}

/** Makes the next `new WorktreeSyncService(config)` return this mock. */
function installService(): ReturnType<typeof makeService> {
  const mocks = makeService();
  mockServiceFactory.mockImplementation((config: unknown) => {
    mocks.service.config = config as Record<string, unknown>;
    return mocks.service;
  });
  return mocks;
}

const registeredConfig = {
  repoUrl: "https://example.com/repo.git",
  bareRepoDir: "/repos/repo/.bare",
  worktreeDir: "/repos/repo/worktrees",
  cronSchedule: "0 * * * *",
  runOnce: true,
};

describe("capability gate with a real RepositoryContext", () => {
  let fixture: Awaited<ReturnType<typeof makeWorktreeFixture>>;

  beforeEach(async () => {
    fixture = await makeWorktreeFixture();
    mockRemoteUrl.mockReset();
    mockWorktreeList.mockReset();
    mockServiceFactory.mockReset();
    mockRemoteUrl.mockResolvedValue("https://github.com/test/repo.git\n");
    mockWorktreeList.mockResolvedValue(
      [`worktree ${fixture.currentWorktree}`, "branch refs/heads/feature-x", ""].join("\n"),
    );
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  const mutators: Array<[string, (ctx: RepositoryContext) => Promise<CallToolResult>]> = [
    ["update_worktree", (ctx) => invoke(handleUpdateWorktree, ctx, { path: fixture.currentWorktree })],
    ["create_worktree", (ctx) => invoke(handleCreateWorktree, ctx, { branchName: "feature-y" })],
  ];

  it.each(mutators)(
    "keeps sync and initialize unavailable after %s clears the discovery cache",
    async (_tool, mutate) => {
      const { service } = installService();
      const ctx = new RepositoryContext({ launchCwd: fixture.currentWorktree });

      const detected = await ctx.detectFromPath(fixture.currentWorktree);
      expect(detected.kind).toBe("unmanaged");
      expect(detected.capabilities.sync.available).toBe(false);
      expect(detected.capabilities.initialize.available).toBe(false);

      const mutation = parseResponse(await mutate(ctx));
      expect(mutation.success).toBe(true);
      expect(service.runExclusiveRepoOperation).toHaveBeenCalledTimes(1);
      // The mutating tool cleared the discovery cache; the gate must not depend on it.
      expect(ctx.getDiscoveredContext()).toBeNull();

      const sync = parseResponse(await invoke(handleSync, ctx, {}));
      expect(sync.code).toBe("CAPABILITY_UNAVAILABLE");
      expect(sync.message).toContain("no config file loaded (running in auto-detect mode)");
      expect(service.sync).not.toHaveBeenCalled();

      const init = parseResponse(await invoke(handleInitialize, ctx, {}));
      expect(init.code).toBe("CAPABILITY_UNAVAILABLE");
      expect(init.message).toContain("no config file loaded (running in auto-detect mode)");
      expect(service.initializeUnlocked).not.toHaveBeenCalled();
      expect(service.runExclusiveRepoOperation).toHaveBeenCalledTimes(1);
    },
  );

  it("denies sync and initialize for a detected entry that was never discovered", async () => {
    const { service } = installService();
    const ctx = new RepositoryContext();
    const name = "__auto_detected__:repo@/repos/repo/.bare";
    ctx.__registerForTest(name, { config: registeredConfig, source: "detected" });
    ctx.__setCurrentRepoForTest(name);
    expect(ctx.getDiscoveredContext()).toBeNull();

    const sync = parseResponse(await invoke(handleSync, ctx, {}));
    expect(sync.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(sync.message).toContain("load_config");

    const init = parseResponse(await invoke(handleInitialize, ctx, {}));
    expect(init.code).toBe("CAPABILITY_UNAVAILABLE");

    // The gate runs before a service is even built for the entry.
    expect(mockServiceFactory).not.toHaveBeenCalled();
    expect(service.sync).not.toHaveBeenCalled();
    expect(service.initializeUnlocked).not.toHaveBeenCalled();
  });

  it("still allows sync for a configured repository whose discovery cache is empty", async () => {
    const { service } = installService();
    const ctx = new RepositoryContext();
    ctx.__registerForTest("configured", { config: registeredConfig, source: "config" });
    expect(ctx.getDiscoveredContext("configured")).toBeNull();

    const sync = parseResponse(await invoke(handleSync, ctx, {}));
    expect(sync.success).toBe(true);
    expect(service.sync).toHaveBeenCalledTimes(1);
  });
});
