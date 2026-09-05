import { afterEach, describe, expect, it, vi } from "vitest";

import {
  handleCreateWorktree,
  handleDetectContext,
  handleGetWorktreeStatus,
  handleInitialize,
  handleListWorktrees,
  handleLoadConfig,
  handleSetCurrentRepository,
  handleSync,
  handleUpdateWorktree,
} from "../handlers";
import { syncOutputSchema } from "../output-schemas";
import { formatErrorResponse } from "../utils";
import { PathResolutionService } from "../../services/path-resolution.service";

import type { Capabilities, DiscoveredRepoContext, RepositoryContext } from "../context";
import type { CallToolResult } from "@modelcontextprotocol/server";

async function invoke<T>(
  handler: (ctx: RepositoryContext, params: T, handlerContext?: any) => Promise<CallToolResult>,
  ctx: RepositoryContext,
  params: T,
): Promise<CallToolResult> {
  try {
    return await handler(ctx, params);
  } catch (err) {
    return formatErrorResponse(err);
  }
}

vi.mock("simple-git", () => ({
  default: vi.fn(() => ({
    raw: vi.fn<any>().mockRejectedValue(new Error("no upstream")),
  })),
}));

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

// create_worktree probes its target path on disk (fs.access via probePathExists).
// The fake /repo/worktrees tree never exists, so default to ENOENT and let the
// target-path tests override it once per call.
const fsMock = vi.hoisted(() => ({ access: vi.fn<any>() }));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  fsMock.access.mockImplementation(() => Promise.reject(errno("ENOENT")));
  return { ...actual, access: fsMock.access };
});

vi.mock("../../utils/disk-space", () => ({
  calculateDirectorySize: vi.fn().mockResolvedValue(123456),
  formatBytes: vi.fn().mockReturnValue("123 KB"),
  calculateSyncDiskSpace: vi.fn().mockResolvedValue("N/A"),
}));

vi.mock("../../services/worktree-status.service", () => {
  class FakeStatusService {
    async getFullWorktreeStatus(): Promise<{
      isClean: boolean;
      hasUnpushedCommits: boolean;
      hasStashedChanges: boolean;
      hasOperationInProgress: boolean;
      hasModifiedSubmodules: boolean;
      upstreamGone: boolean;
      canRemove: boolean;
      reasons: string[];
    }> {
      return {
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        canRemove: true,
        reasons: [],
      };
    }
  }
  return { WorktreeStatusService: FakeStatusService };
});

function makeCapabilities(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    listWorktrees: { available: true },
    getStatus: { available: true },
    createWorktree: { available: true },
    updateWorktree: { available: true },
    sync: { available: true },
    initialize: { available: true },
    ...overrides,
  };
}

function makeDiscovered(overrides: Partial<DiscoveredRepoContext> = {}): DiscoveredRepoContext {
  return {
    isWorktree: true,
    kind: "managed",
    currentBranch: "main",
    currentWorktreePath: "/repo/main",
    bareRepoPath: "/repo/.bare",
    repoUrl: "https://example.com/repo.git",
    worktreeDir: "/repo/worktrees",
    allWorktrees: [],
    siblingRepositories: [],
    configPath: null,
    repoName: "test",
    capabilities: makeCapabilities(),
    notes: [],
    ...overrides,
  };
}

type MockGit = {
  fetchAll: ReturnType<typeof vi.fn>;
  fetchBranch: ReturnType<typeof vi.fn>;
  getWorktrees: ReturnType<typeof vi.fn>;
  getFullWorktreeStatus: ReturnType<typeof vi.fn>;
  branchExists: ReturnType<typeof vi.fn>;
  createBranch: ReturnType<typeof vi.fn>;
  pushBranch: ReturnType<typeof vi.fn>;
  addWorktree: ReturnType<typeof vi.fn>;
  updateWorktree: ReturnType<typeof vi.fn>;
  getDefaultBranch: ReturnType<typeof vi.fn>;
  getWorktreeMetadata: ReturnType<typeof vi.fn>;
};

function makeCtx(opts: {
  discovered?: DiscoveredRepoContext | null;
  baseCapabilities?: Capabilities | null;
  git?: Partial<MockGit>;
  syncInProgress?: boolean;
  loadConfigImpl?: (configPath: string) => Promise<unknown>;
  currentRepo?: string;
  configPath?: string | null;
  launchCwd?: string;
  configuredRepoNames?: string[];
  configuredRepositorySummaries?: unknown[];
  allConfiguredWorktrees?: Record<string, Array<{ path: string; branch: string; isCurrent: boolean }>>;
  allConfiguredWorktreeErrors?: Record<string, string>;
  service?: Record<string, unknown>;
}): { ctx: RepositoryContext; git: MockGit; service: any } {
  const git: MockGit = {
    fetchAll: vi.fn<any>().mockResolvedValue(undefined),
    fetchBranch: vi.fn<any>().mockResolvedValue(undefined),
    getWorktrees: vi.fn<any>().mockResolvedValue([]),
    getFullWorktreeStatus: vi.fn<any>(),
    branchExists: vi.fn<any>(),
    createBranch: vi.fn<any>(),
    pushBranch: vi.fn<any>(),
    addWorktree: vi.fn<any>(),
    updateWorktree: vi.fn<any>(),
    getDefaultBranch: vi.fn<any>().mockReturnValue("main"),
    getWorktreeMetadata: vi.fn<any>().mockResolvedValue(null),
    ...opts.git,
  };

  const service = {
    config: { worktreeDir: "/repo/worktrees" },
    isInitialized: vi.fn<any>().mockReturnValue(true),
    isSyncInProgress: vi.fn<any>().mockReturnValue(opts.syncInProgress ?? false),
    initialize: vi.fn<any>().mockResolvedValue(undefined),
    initializeUnlocked: vi.fn<any>().mockResolvedValue(undefined),
    runExclusiveRepoOperation: vi.fn<any>().mockImplementation(async (operation: unknown) => ({
      started: true,
      value: await (operation as () => Promise<unknown>)(),
    })),
    sync: vi.fn<any>().mockResolvedValue({
      started: true,
      outcome: {
        mode: "worktree",
        started: true,
        counts: { created: 0, removed: 0, updated: 0, skipped: 0, preserved: 0, failed: 0, noop: 0 },
        actions: [],
      },
    }),
    getGitService: () => git,
    getDefaultBranch: vi.fn<any>().mockResolvedValue("main"),
    getWorktrees: vi.fn<any>().mockImplementation(() => (git.getWorktrees as any)()),
    isCloneMode: vi.fn<any>().mockReturnValue(false),
    getRecordedSkips: vi.fn<any>().mockReturnValue([]),
    clearRecordedSkips: vi.fn<any>(),
    clearPendingInitSkip: vi.fn<any>(),
    ...opts.service,
  };

  const ctx = {
    detectFromPath: vi.fn<any>().mockResolvedValue(opts.discovered ?? makeDiscovered()),
    getDiscoveredContext: vi.fn<any>().mockReturnValue(opts.discovered ?? makeDiscovered()),
    getBaseCapabilities: vi
      .fn<any>()
      .mockReturnValue(opts.baseCapabilities === undefined ? makeCapabilities() : opts.baseCapabilities),
    getEntry: vi.fn<any>().mockReturnValue({
      name: opts.currentRepo ?? "test",
      service,
    }),
    getService: vi.fn<any>().mockResolvedValue(service),
    loadConfig: vi.fn<any>().mockImplementation((opts.loadConfigImpl ?? (async () => [])) as any),
    getCurrentRepo: vi.fn<any>().mockReturnValue(opts.currentRepo ?? "test"),
    getConfigPath: vi.fn<any>().mockReturnValue(opts.configPath ?? null),
    findConfigUpward: vi.fn<any>().mockResolvedValue(null),
    getLaunchCwd: vi.fn<any>().mockReturnValue(opts.launchCwd ?? "/repo/main"),
    autoSelectCurrentRepoIfSingleConfig: vi.fn<any>().mockReturnValue(opts.currentRepo ?? "test"),
    getRepositoryList: vi.fn<any>().mockReturnValue([]),
    getConfiguredRepositoryNames: vi.fn<any>().mockReturnValue(opts.configuredRepoNames ?? []),
    getConfiguredRepositorySummaries: vi.fn<any>().mockResolvedValue(opts.configuredRepositorySummaries ?? []),
    getAllConfiguredWorktreeDetails: vi.fn<any>().mockResolvedValue({
      worktreesByRepo: opts.allConfiguredWorktrees ?? {},
      errorsByRepo: opts.allConfiguredWorktreeErrors ?? {},
    }),
    setCurrentRepo: vi.fn<any>(),
    invalidateDiscovered: vi.fn<any>(),
  } as unknown as RepositoryContext;

  return { ctx, git, service };
}

function parseResponse(result: any): any {
  const parsed = JSON.parse(result.content[0].text);
  // Every tool advertises an outputSchema, so a success result must also carry
  // structuredContent — the SDK turns a result that omits it into an error.
  if (result.isError !== true) {
    expect(result.structuredContent).toEqual(parsed);
  }
  return parsed;
}

describe("handleListWorktrees", () => {
  it("returns enriched worktree list", async () => {
    const { ctx, git } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([
          { path: "/repo/main", branch: "main", isCurrent: true },
          { path: "/repo/worktrees/feature", branch: "feature", isCurrent: false },
        ]),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({
          isClean: true,
          hasUnpushedCommits: false,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: true,
          reasons: [],
        }),
      },
    });

    const result = await invoke(handleListWorktrees, ctx, {});
    const body = parseResponse(result);
    expect(body.worktrees).toHaveLength(2);
    expect(body.worktrees[0].label).toBe("current");
    expect(body.worktrees[1].label).toBe("clean");
    expect(body.worktrees[1].safeToRemove).toEqual({ safe: true, reason: expect.any(String) });
    expect(body.worktrees[1].sizeBytes).toBeNull();
    expect(git.getWorktrees).toHaveBeenCalled();
  });

  it("fails with CAPABILITY_UNAVAILABLE when canListWorktrees is false", async () => {
    const { ctx } = makeCtx({
      discovered: makeDiscovered({
        capabilities: makeCapabilities({ listWorktrees: { available: false, reason: "test reason" } }),
        notes: ["test reason"],
      }),
    });

    const result = await invoke(handleListWorktrees, ctx, {});
    const body = parseResponse(result);
    expect(body.error).toBe(true);
    expect(body.code).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("groups all configured repos when repoName is omitted", async () => {
    const cleanStatus = {
      isClean: true,
      hasUnpushedCommits: false,
      hasStashedChanges: false,
      hasOperationInProgress: false,
      hasModifiedSubmodules: false,
      upstreamGone: false,
      canRemove: true,
      reasons: [],
    };
    const gitByRepo = {
      "repo-a": {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/repos/a/main", branch: "main" }]),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue(cleanStatus),
        getWorktreeMetadata: vi.fn<any>().mockResolvedValue({ lastSyncDate: "2026-05-17T00:00:00.000Z" }),
      },
      "repo-b": {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/repos/b/feature", branch: "feature" }]),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue(cleanStatus),
        getWorktreeMetadata: vi.fn<any>().mockResolvedValue(null),
      },
    };

    const ctx = {
      getConfiguredRepositoryNames: vi.fn<any>().mockReturnValue(["repo-a", "repo-b"]),
      getBaseCapabilities: vi.fn<any>().mockReturnValue(makeCapabilities()),
      getDiscoveredContext: vi.fn<any>().mockImplementation((repoName: unknown) =>
        makeDiscovered({
          repoName: String(repoName),
          currentWorktreePath: repoName === "repo-a" ? "/repos/a/main" : null,
        }),
      ),
      getService: vi.fn<any>().mockImplementation(async (repoName: unknown) => {
        const name = repoName as "repo-a" | "repo-b";
        return {
          isInitialized: vi.fn<any>().mockReturnValue(true),
          getGitService: () => gitByRepo[name],
        };
      }),
    } as unknown as RepositoryContext;

    const result = await invoke(handleListWorktrees, ctx, {});
    const body = parseResponse(result);

    expect(Object.keys(body.repositories)).toEqual(["repo-a", "repo-b"]);
    expect(body.repositories["repo-a"].worktrees[0]).toMatchObject({
      path: "/repos/a/main",
      branch: "main",
      isCurrent: true,
      label: "current",
    });
    expect(body.repositories["repo-b"].worktrees[0]).toMatchObject({
      path: "/repos/b/feature",
      branch: "feature",
      isCurrent: false,
      label: "clean",
    });
  });

  it("captures per-repo errors when grouped list_worktrees cannot read one repo", async () => {
    const cleanStatus = {
      isClean: true,
      hasUnpushedCommits: false,
      hasStashedChanges: false,
      hasOperationInProgress: false,
      hasModifiedSubmodules: false,
      upstreamGone: false,
      canRemove: true,
      reasons: [],
    };
    const gitByRepo = {
      "repo-a": {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/repos/a/main", branch: "main" }]),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue(cleanStatus),
        getWorktreeMetadata: vi.fn<any>().mockResolvedValue(null),
      },
    };

    const ctx = {
      getConfiguredRepositoryNames: vi.fn<any>().mockReturnValue(["repo-a", "repo-b"]),
      getBaseCapabilities: vi.fn<any>().mockReturnValue(makeCapabilities()),
      getDiscoveredContext: vi.fn<any>().mockImplementation((repoName: unknown) =>
        makeDiscovered({
          repoName: String(repoName),
          currentWorktreePath: null,
        }),
      ),
      getService: vi.fn<any>().mockImplementation(async (repoName: unknown) => {
        if (repoName === "repo-b") {
          throw new Error("repo-b unavailable");
        }
        return {
          isInitialized: vi.fn<any>().mockReturnValue(true),
          getGitService: () => gitByRepo["repo-a"],
        };
      }),
    } as unknown as RepositoryContext;

    const result = await invoke(handleListWorktrees, ctx, {});
    const body = parseResponse(result);

    expect(body.repositories["repo-a"].worktrees).toHaveLength(1);
    expect(body.repositories["repo-b"]).toEqual({
      worktrees: [],
      error: "repo-b unavailable",
    });
  });

  it("lists the single checkout for clone-mode repos", async () => {
    const { ctx, git, service } = makeCtx({
      service: {
        isCloneMode: vi.fn<any>().mockReturnValue(true),
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/repo/clone", branch: "main" }]),
      },
      git: {
        getWorktrees: vi.fn<any>().mockRejectedValue(new Error("bare repo missing")),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({
          isClean: true,
          hasUnpushedCommits: false,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: true,
          reasons: [],
        }),
      },
    });

    const result = await invoke(handleListWorktrees, ctx, {});
    const body = parseResponse(result);

    expect(body.worktrees).toHaveLength(1);
    expect(body.worktrees[0]).toMatchObject({
      path: "/repo/clone",
      branch: "main",
      label: "clean",
    });
    expect(service.getWorktrees).toHaveBeenCalled();
    expect(git.getWorktrees).not.toHaveBeenCalled();
  });
});

describe("handleCreateWorktree", () => {
  it("creates worktree for existing remote branch without creating branch", async () => {
    const { ctx, git } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: false, remote: true }),
      },
    });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "feature/x" });
    const body = parseResponse(result);
    expect(body.success).toBe(true);
    expect(body.created).toBe(false);
    expect(body.pushed).toBe(false);
    expect(git.createBranch).not.toHaveBeenCalled();
    expect(git.addWorktree).toHaveBeenCalledWith("feature/x", expect.stringContaining("feature-x"));
  });

  it("fetches before checking the branch matrix", async () => {
    const callOrder: string[] = [];
    let remoteExists = false;
    const { ctx } = makeCtx({
      git: {
        fetchAll: vi.fn<any>().mockImplementation(async () => {
          callOrder.push("fetchAll");
          remoteExists = true;
        }),
        branchExists: vi.fn<any>().mockImplementation(async () => {
          callOrder.push("branchExists");
          return { local: false, remote: remoteExists };
        }),
      },
    });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "feature/fresh" });
    const body = parseResponse(result);

    expect(body.success).toBe(true);
    expect(callOrder).toEqual(["fetchAll", "branchExists"]);
  });

  it("creates and pushes a missing branch by default when baseBranch is provided", async () => {
    const { ctx, git } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: false, remote: false }),
      },
    });

    const result = await invoke(handleCreateWorktree, ctx, {
      branchName: "new-branch",
      baseBranch: "main",
    });
    const body = parseResponse(result);
    expect(body.created).toBe(true);
    expect(body.pushed).toBe(true);
    expect(git.createBranch).toHaveBeenCalledWith("new-branch", "main");
    expect(git.pushBranch).toHaveBeenCalledWith("new-branch");
  });

  it("errors when branch missing and no baseBranch", async () => {
    const { ctx } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: false, remote: false }),
      },
    });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "new-branch" });
    const body = parseResponse(result);
    expect(body.error).toBe(true);
  });

  it("fails with SYNC_IN_PROGRESS when sync running", async () => {
    const { ctx, service } = makeCtx({ syncInProgress: true });
    service.runExclusiveRepoOperation.mockResolvedValueOnce({ started: false, reason: "in_progress" });
    const result = await invoke(handleCreateWorktree, ctx, { branchName: "x", baseBranch: "main" });
    const body = parseResponse(result);
    expect(body.code).toBe("SYNC_IN_PROGRESS");
  });

  it("does not touch git when another process holds the repo operation lock", async () => {
    const { ctx, git, service } = makeCtx({
      git: {
        branchExists: vi.fn<any>(),
        createBranch: vi.fn<any>(),
        addWorktree: vi.fn<any>(),
      },
    });
    service.runExclusiveRepoOperation.mockResolvedValueOnce({ started: false, reason: "locked" });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "new-branch", baseBranch: "main" });
    const body = parseResponse(result);

    expect(body.code).toBe("SYNC_IN_PROGRESS");
    expect(git.branchExists).not.toHaveBeenCalled();
    expect(git.createBranch).not.toHaveBeenCalled();
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

  it("returns LOCK_UNAVAILABLE naming the path and errno when the repo lock cannot be taken", async () => {
    const { ctx, git, service } = makeCtx({
      git: {
        branchExists: vi.fn<any>(),
        createBranch: vi.fn<any>(),
        addWorktree: vi.fn<any>(),
      },
    });
    service.runExclusiveRepoOperation.mockResolvedValueOnce({
      started: false,
      reason: "lock_unavailable",
      path: "/state/sync-worktrees/locks",
      code: "ENOTDIR",
      error: "ENOTDIR: not a directory, mkdir '/state/sync-worktrees/locks'",
    });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "new-branch", baseBranch: "main" });
    const body = parseResponse(result);

    expect(result.isError).toBe(true);
    expect(body.code).toBe("LOCK_UNAVAILABLE");
    expect(body.message).toContain("/state/sync-worktrees/locks");
    expect(body.message).toContain("ENOTDIR");
    expect(body.message).not.toMatch(/in progress/i);
    expect(git.createBranch).not.toHaveBeenCalled();
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

  it("creates branch and worktree without pushing when push:false (push:false flow)", async () => {
    const { ctx, git } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: false, remote: false }),
      },
    });

    const result = await invoke(handleCreateWorktree, ctx, {
      branchName: "feat/ws-communication",
      baseBranch: "main",
      push: false,
    });
    const body = parseResponse(result);

    expect(body.success).toBe(true);
    expect(body.created).toBe(true);
    expect(body.pushed).toBe(false);
    expect(git.createBranch).toHaveBeenCalledWith("feat/ws-communication", "main");
    expect(git.addWorktree).toHaveBeenCalledWith(
      "feat/ws-communication",
      expect.stringContaining("feat-ws-communication"),
    );
    expect(git.pushBranch).not.toHaveBeenCalled();
  });

  it("does not push when addWorktree fails", async () => {
    const addWorktreeError = new Error("addWorktree failed");
    const { ctx, git } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: false, remote: false }),
        addWorktree: vi.fn<any>().mockRejectedValue(addWorktreeError),
      },
    });

    const result = await invoke(handleCreateWorktree, ctx, {
      branchName: "new-branch",
      baseBranch: "main",
    });
    const body = parseResponse(result);
    expect(body.error).toBe(true);
    expect(git.createBranch).toHaveBeenCalled();
    expect(git.pushBranch).not.toHaveBeenCalled();
  });

  it.each([
    ["leading dash", "-D"],
    ["double dot", "foo..bar"],
    ["trailing .lock", "feature.lock"],
    ["empty", ""],
    ["control char", "foo\x00bar"],
  ])("rejects invalid branch name (%s) before touching git", async (_label, badName) => {
    const { ctx, git } = makeCtx({
      git: {
        branchExists: vi.fn<any>(),
        createBranch: vi.fn<any>(),
        addWorktree: vi.fn<any>(),
      },
    });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: badName, baseBranch: "main" });
    const body = parseResponse(result);
    expect(body.error).toBe(true);
    expect(git.branchExists).not.toHaveBeenCalled();
    expect(git.createBranch).not.toHaveBeenCalled();
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

  it("pushes only after addWorktree succeeds", async () => {
    const callOrder: string[] = [];
    const { ctx, git } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: false, remote: false }),
        createBranch: vi.fn<any>().mockImplementation(async () => {
          callOrder.push("createBranch");
        }),
        addWorktree: vi.fn<any>().mockImplementation(async () => {
          callOrder.push("addWorktree");
        }),
        pushBranch: vi.fn<any>().mockImplementation(async () => {
          callOrder.push("pushBranch");
        }),
      },
    });

    await invoke(handleCreateWorktree, ctx, {
      branchName: "new-branch",
      baseBranch: "main",
    });

    expect(callOrder).toEqual(["createBranch", "addWorktree", "pushBranch"]);
    expect(git.addWorktree).toHaveBeenCalled();
    expect(git.pushBranch).toHaveBeenCalledWith("new-branch");
  });

  it("returns partial success details when push fails after worktree creation", async () => {
    const { ctx, git } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: false, remote: false }),
        pushBranch: vi.fn<any>().mockRejectedValue(new Error("non-fast-forward")),
      },
    });

    const result = await invoke(handleCreateWorktree, ctx, {
      branchName: "new-branch",
      baseBranch: "main",
    });
    const body = parseResponse(result);

    expect(body).toMatchObject({
      success: false,
      branchName: "new-branch",
      created: true,
      pushed: false,
      pushError: "non-fast-forward",
    });
    expect(git.addWorktree).toHaveBeenCalled();
  });

  it("is unavailable for clone-mode repositories", async () => {
    const { ctx, git, service } = makeCtx({
      service: { isCloneMode: vi.fn<any>().mockReturnValue(true) },
    });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "feature/x", baseBranch: "main" });
    const body = parseResponse(result);

    expect(body.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(service.runExclusiveRepoOperation).not.toHaveBeenCalled();
    expect(git.addWorktree).not.toHaveBeenCalled();
  });
});

describe("handleSync", () => {
  it("fails when canSync=false", async () => {
    const { ctx } = makeCtx({
      discovered: makeDiscovered({
        capabilities: makeCapabilities({ sync: { available: false, reason: "no config" } }),
        notes: ["no config"],
      }),
    });
    const result = await invoke(handleSync, ctx, {});
    const body = parseResponse(result);
    expect(body.code).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("allows sync for a config-source entry whose discovery cache is empty", async () => {
    const { ctx, service } = makeCtx({});
    (ctx.getDiscoveredContext as any).mockReturnValue(null);

    const result = await invoke(handleSync, ctx, {});
    const body = parseResponse(result);

    expect(body.success).toBe(true);
    expect(service.sync).toHaveBeenCalledTimes(1);
  });

  it("denies sync from durable capabilities when the discovery cache is empty", async () => {
    const { ctx, service } = makeCtx({
      baseCapabilities: makeCapabilities({
        sync: { available: false, reason: "repository is not listed in the loaded config" },
      }),
    });
    (ctx.getDiscoveredContext as any).mockReturnValue(null);

    const result = await invoke(handleSync, ctx, {});
    const body = parseResponse(result);

    expect(body.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(body.message).toContain("not listed in the loaded config");
    expect(ctx.getService).not.toHaveBeenCalled();
    expect(service.sync).not.toHaveBeenCalled();
  });

  it("lets a durable denial win over a discovered context that reports sync as available", async () => {
    const { ctx, service } = makeCtx({
      discovered: makeDiscovered({ capabilities: makeCapabilities({ sync: { available: true } }) }),
      baseCapabilities: makeCapabilities({ sync: { available: false, reason: "no config file loaded" } }),
    });

    const result = await invoke(handleSync, ctx, {});
    const body = parseResponse(result);

    expect(body.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(body.message).toContain("no config file loaded");
    expect(service.sync).not.toHaveBeenCalled();
  });

  it("calls service.sync and returns duration", async () => {
    const { ctx, service } = makeCtx({});
    const result = await invoke(handleSync, ctx, {});
    const body = parseResponse(result);
    expect(body.success).toBe(true);
    expect(body.failed).toBe(0);
    expect(body.failures).toEqual([]);
    expect(typeof body.duration).toBe("number");
    expect(service.sync).toHaveBeenCalled();
    expect(body.outcome).toMatchObject({
      mode: "worktree",
      started: true,
      counts: { created: 0, removed: 0, updated: 0, skipped: 0, preserved: 0, failed: 0, noop: 0 },
      actions: [],
    });
    expect(typeof body.outcome.durationMs).toBe("number");
    expect(body.skips).toEqual([]);
    expect(syncOutputSchema.safeParse(result.structuredContent).success).toBe(true);
  });

  it("reports success=false with the failed count and failures when the outcome recorded failures", async () => {
    const { ctx, service } = makeCtx({});
    const failure = {
      kind: "failed",
      scope: "worktree",
      error: "EACCES: permission denied, rename '/repo/worktrees/b' -> '/repo/.trash/b'",
      reason: "remove_failed",
      branch: "b",
      path: "/repo/worktrees/b",
    };
    // The runner collects per-worktree failures via Promise.allSettled and
    // records them on the outcome instead of rejecting sync().
    service.sync.mockResolvedValue({
      started: true,
      outcome: {
        mode: "worktree",
        started: true,
        counts: { created: 1, removed: 0, updated: 0, skipped: 0, preserved: 0, failed: 1, noop: 0 },
        actions: [{ kind: "created", branch: "a", path: "/repo/worktrees/a" }, failure],
      },
    });

    const result = await invoke(handleSync, ctx, {});
    const body = parseResponse(result);

    // The call itself completed, so this is a structured result, not an error.
    expect(result.isError).not.toBe(true);
    expect(body.success).toBe(false);
    expect(body.failed).toBe(1);
    expect(body.failures).toEqual([failure]);
    expect(body.outcome.counts.failed).toBe(1);
    expect(body.outcome.actions).toHaveLength(2);
    expect(syncOutputSchema.safeParse(result.structuredContent).success).toBe(true);
  });

  it("reports success=false for a clone-mode outcome that recorded a repo-scoped failure", async () => {
    const { ctx, service } = makeCtx({
      service: { isCloneMode: vi.fn<any>().mockReturnValue(true) },
    });
    const failure = { kind: "failed", scope: "repo", error: "fetch failed", reason: "sync_failed" };
    service.sync.mockResolvedValue({
      started: true,
      outcome: {
        mode: "clone",
        started: true,
        counts: { created: 0, removed: 0, updated: 0, skipped: 0, preserved: 0, failed: 1, noop: 0 },
        actions: [failure],
      },
    });

    const result = await invoke(handleSync, ctx, {});
    const body = parseResponse(result);

    expect(result.isError).not.toBe(true);
    expect(body.success).toBe(false);
    expect(body.failed).toBe(1);
    expect(body.failures).toEqual([failure]);
    expect(body.outcome.mode).toBe("clone");
  });

  it("treats a result without an outcome as a success with no failures", async () => {
    const { ctx, service } = makeCtx({});
    service.sync.mockResolvedValue({ started: true });

    const result = await invoke(handleSync, ctx, {});
    const body = parseResponse(result);

    expect(body.success).toBe(true);
    expect(body.failed).toBe(0);
    expect(body.failures).toEqual([]);
    expect(body.outcome.counts.failed).toBe(0);
    expect(syncOutputSchema.safeParse(result.structuredContent).success).toBe(true);
  });

  it("invokes autoSelectCurrentRepoIfSingleConfig when repoName is omitted", async () => {
    const { ctx } = makeCtx({});
    await invoke(handleSync, ctx, {});
    expect((ctx as any).autoSelectCurrentRepoIfSingleConfig).toHaveBeenCalled();
  });

  it("does not invoke auto-select when repoName is explicitly passed", async () => {
    const { ctx } = makeCtx({});
    await invoke(handleSync, ctx, { repoName: "explicit" });
    expect((ctx as any).autoSelectCurrentRepoIfSingleConfig).not.toHaveBeenCalled();
  });

  it("surfaces recorded skips with formatted messages in the payload", async () => {
    const { ctx, service } = makeCtx({});
    service.getRecordedSkips.mockReturnValue([
      { kind: "branch_mismatch", phase: "sync", currentBranch: "feature", expectedBranch: "main" },
      { kind: "dirty_tree" },
    ]);
    const result = await invoke(handleSync, ctx, {});
    const body = parseResponse(result);
    expect(body.success).toBe(true);
    expect(body.skips).toEqual([
      {
        kind: "branch_mismatch",
        phase: "sync",
        currentBranch: "feature",
        expectedBranch: "main",
        message: "clone is on 'feature', expected 'main' — update 'branch' in the config or switch the clone back",
      },
      { kind: "dirty_tree", message: "working tree has local changes" },
    ]);
  });

  it("returns only skips recorded by the current run, not stale ones from a previous run", async () => {
    const { ctx, service } = makeCtx({});
    // The real service clears recorded skips at the start of sync() (inside
    // the lock); the handler no longer clears them itself. Simulate that:
    // stale skips exist before sync, sync replaces them with the new run's.
    service.getRecordedSkips.mockReturnValue([{ kind: "dirty_tree" }]);
    service.sync.mockImplementation(async () => {
      service.getRecordedSkips.mockReturnValue([
        { kind: "branch_mismatch", phase: "sync", currentBranch: "feature", expectedBranch: "main" },
      ]);
      return {
        started: true,
        outcome: {
          mode: "clone",
          started: true,
          counts: { created: 0, removed: 0, updated: 0, skipped: 1, preserved: 0, failed: 0, noop: 0 },
          actions: [],
        },
      };
    });

    const result = await invoke(handleSync, ctx, {});
    const body = parseResponse(result);

    expect(body.success).toBe(true);
    expect(body.skips).toEqual([
      {
        kind: "branch_mismatch",
        phase: "sync",
        currentBranch: "feature",
        expectedBranch: "main",
        message: "clone is on 'feature', expected 'main' — update 'branch' in the config or switch the clone back",
      },
    ]);
  });

  it("returns SYNC_IN_PROGRESS when sync returns started:false", async () => {
    const { ctx, service } = makeCtx({});
    service.sync.mockResolvedValue({ started: false, reason: "in_progress" });
    const result = await invoke(handleSync, ctx, {});
    const body = parseResponse(result);
    expect(body.code).toBe("SYNC_IN_PROGRESS");
  });

  it("keeps a contended lock as SYNC_IN_PROGRESS", async () => {
    const { ctx, service } = makeCtx({});
    service.sync.mockResolvedValue({ started: false, reason: "locked" });
    const result = await invoke(handleSync, ctx, {});
    const body = parseResponse(result);
    expect(body.code).toBe("SYNC_IN_PROGRESS");
  });

  it("returns LOCK_UNAVAILABLE naming the path and errno when the repo lock cannot be taken", async () => {
    // Not contention and not retryable: the sync never ran. The error must
    // carry the cause rather than claim a sync is already in progress.
    const { ctx, service } = makeCtx({});
    service.sync.mockResolvedValue({
      started: false,
      reason: "lock_unavailable",
      path: "/state/sync-worktrees/locks",
      code: "ENOTDIR",
      error: "ENOTDIR: not a directory, mkdir '/state/sync-worktrees/locks'",
    });
    const result = await invoke(handleSync, ctx, {});
    const body = parseResponse(result);
    expect(result.isError).toBe(true);
    expect(body.code).toBe("LOCK_UNAVAILABLE");
    expect(body.message).toContain("/state/sync-worktrees/locks");
    expect(body.message).toContain("ENOTDIR");
    expect(body.message).not.toMatch(/in progress/i);
  });

  it("delegates initialization to service.sync when needed", async () => {
    const { ctx, service } = makeCtx({});
    service.isInitialized.mockReturnValue(false);

    const result = await invoke(handleSync, ctx, {});
    const body = parseResponse(result);

    expect(body.success).toBe(true);
    expect(service.initialize).not.toHaveBeenCalled();
    expect(service.sync).toHaveBeenCalled();
  });

  it("sends progress notifications from structured events", async () => {
    const { ctx, service } = makeCtx({});
    const progressListeners: Array<(e: { phase: string; message: string }) => void> = [];
    service.onProgress = vi.fn<any>().mockImplementation((listener: any) => {
      progressListeners.push(listener);
      return () => {
        const idx = progressListeners.indexOf(listener);
        if (idx >= 0) progressListeners.splice(idx, 1);
      };
    });
    service.sync.mockImplementation(async () => {
      for (const l of progressListeners) l({ phase: "fetch", message: "Fetching" });
      for (const l of progressListeners) l({ phase: "create", message: "Creating" });
      return { started: true };
    });

    const notify = vi.fn<any>().mockResolvedValue(undefined);
    const handlerContext = { mcpReq: { _meta: { progressToken: "tok-1" }, notify } };
    await handleSync(ctx, {}, handlerContext as any);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenNthCalledWith(1, {
      method: "notifications/progress",
      params: { progressToken: "tok-1", progress: 1, message: "[fetch] Fetching" },
    });
    expect(notify).toHaveBeenNthCalledWith(2, {
      method: "notifications/progress",
      params: { progressToken: "tok-1", progress: 2, message: "[create] Creating" },
    });
  });

  it("unsubscribes progress listener even when sync throws", async () => {
    const { ctx, service } = makeCtx({});
    const unsubscribe = vi.fn<any>();
    service.onProgress = vi.fn<any>().mockReturnValue(unsubscribe);
    service.sync.mockRejectedValue(new Error("boom"));

    const handlerContext = {
      mcpReq: { _meta: { progressToken: "tok-1" }, notify: vi.fn<any>().mockResolvedValue(undefined) },
    };
    await expect(handleSync(ctx, {}, handlerContext as any)).rejects.toThrow("boom");
    expect(unsubscribe).toHaveBeenCalled();
  });
});

describe("handleInitialize", () => {
  it("reports clone-mode configured branch as defaultBranch", async () => {
    const { ctx, service } = makeCtx({
      service: {
        isCloneMode: vi.fn<any>().mockReturnValue(true),
        getDefaultBranch: vi.fn<any>().mockResolvedValue("develop"),
      },
    });

    const result = await invoke(handleInitialize, ctx, {});
    const body = parseResponse(result);

    expect(body.defaultBranch).toBe("develop");
    expect(service.getDefaultBranch).toHaveBeenCalled();
  });

  it("denies initialize from durable capabilities when the discovery cache is empty", async () => {
    const { ctx, service } = makeCtx({
      baseCapabilities: makeCapabilities({
        initialize: { available: false, reason: "no config file loaded (running in auto-detect mode)" },
      }),
    });
    (ctx.getDiscoveredContext as any).mockReturnValue(null);

    const result = await invoke(handleInitialize, ctx, {});
    const body = parseResponse(result);

    expect(body.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(body.message).toContain("auto-detect mode");
    expect(ctx.getService).not.toHaveBeenCalled();
    expect(service.initializeUnlocked).not.toHaveBeenCalled();
  });

  it("sends progress notifications when service emits events", async () => {
    const { ctx, service } = makeCtx({});
    service.isInitialized.mockReturnValue(false);
    const progressListeners: Array<(e: { phase: string; message: string }) => void> = [];
    service.onProgress = vi.fn<any>().mockImplementation((listener: any) => {
      progressListeners.push(listener);
      return () => {
        const idx = progressListeners.indexOf(listener);
        if (idx >= 0) progressListeners.splice(idx, 1);
      };
    });
    service.initializeUnlocked.mockImplementation(async () => {
      for (const l of progressListeners) l({ phase: "initialize", message: "Initializing repository" });
    });

    const notify = vi.fn<any>().mockResolvedValue(undefined);
    const handlerContext = { mcpReq: { _meta: { progressToken: "init-1" }, notify } };
    await handleInitialize(ctx, {}, handlerContext as any);

    expect(notify).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: { progressToken: "init-1", progress: 1, message: "[initialize] Initializing repository" },
    });
  });
});

describe("case-insensitive path handling in handlers", () => {
  const originalPlatform = process.platform;

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  }

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("accepts mixed-case worktree path when running on darwin", async () => {
    setPlatform("darwin");
    const { ctx, git } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/Users/foo/Repo/Feature", branch: "feature" }]),
      },
    });
    const result = await invoke(handleUpdateWorktree, ctx, { path: "/users/foo/repo/feature" });
    const body = parseResponse(result);
    expect(body.success).toBe(true);
    expect(git.updateWorktree).toHaveBeenCalledWith("/Users/foo/Repo/Feature");
  });

  it("rejects mixed-case worktree path on linux (case-sensitive)", async () => {
    setPlatform("linux");
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/Users/foo/Repo/Feature", branch: "feature" }]),
      },
    });
    const result = await invoke(handleUpdateWorktree, ctx, { path: "/users/foo/repo/feature" });
    const body = parseResponse(result);
    expect(body.error).toBe(true);
  });
});

describe("handleUpdateWorktree", () => {
  it("calls updateWorktree on given path", async () => {
    const { ctx, git, service } = makeCtx({
      git: { getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/feature", branch: "feature" }]) },
    });
    const result = await invoke(handleUpdateWorktree, ctx, { path: "/w/feature" });
    const body = parseResponse(result);
    expect(body.success).toBe(true);
    expect(service.runExclusiveRepoOperation).toHaveBeenCalledTimes(1);
    expect(git.fetchBranch).toHaveBeenCalledWith("feature");
    expect(git.updateWorktree).toHaveBeenCalledWith("/w/feature");
  });

  it("fetches the target branch before updating the worktree", async () => {
    const callOrder: string[] = [];
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/feature", branch: "feature" }]),
        fetchBranch: vi.fn<any>().mockImplementation(async () => {
          callOrder.push("fetchBranch");
        }),
        updateWorktree: vi.fn<any>().mockImplementation(async () => {
          callOrder.push("updateWorktree");
        }),
      },
    });

    const result = await invoke(handleUpdateWorktree, ctx, { path: "/w/feature" });
    const body = parseResponse(result);

    expect(body.success).toBe(true);
    expect(callOrder).toEqual(["fetchBranch", "updateWorktree"]);
  });

  it("rejects path outside repository", async () => {
    const { ctx } = makeCtx({
      git: { getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/other", branch: "other" }]) },
    });
    const result = await invoke(handleUpdateWorktree, ctx, { path: "/elsewhere" });
    const body = parseResponse(result);
    expect(body.error).toBe(true);
    expect(body.message).toContain("not a registered worktree");
  });

  it("surfaces worktree listing failures as verification errors", async () => {
    const { ctx } = makeCtx({
      discovered: makeDiscovered({ allWorktrees: [] }),
      git: { getWorktrees: vi.fn<any>().mockRejectedValue(new Error("bare repo corrupt")) },
    });

    const result = await invoke(handleUpdateWorktree, ctx, { path: "/w/feature" });
    const body = parseResponse(result);

    expect(body.error).toBe(true);
    expect(body.message).toContain("Could not verify worktree membership: bare repo corrupt");
    expect(body.message).not.toContain("not a registered worktree");
  });

  it("is unavailable for clone-mode repositories", async () => {
    const { ctx, git, service } = makeCtx({
      service: { isCloneMode: vi.fn<any>().mockReturnValue(true) },
    });

    const result = await invoke(handleUpdateWorktree, ctx, { path: "/repo/clone" });
    const body = parseResponse(result);

    expect(body.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(service.runExclusiveRepoOperation).not.toHaveBeenCalled();
    expect(git.updateWorktree).not.toHaveBeenCalled();
  });
});

describe("handleGetWorktreeStatus", () => {
  it("returns status with resolved path", async () => {
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/x", branch: "x" }]),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({
          isClean: false,
          reasons: ["dirty"],
        }),
      },
    });
    const result = await invoke(handleGetWorktreeStatus, ctx, { path: "/w/x" });
    const body = parseResponse(result);
    expect(body.path).toContain("w/x");
    expect(body.isClean).toBe(false);
  });

  it("invokes autoSelectCurrentRepoIfSingleConfig when repoName is omitted on a path-based handler", async () => {
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/x", branch: "x" }]),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({ isClean: true, reasons: [] }),
      },
    });
    await invoke(handleGetWorktreeStatus, ctx, { path: "/w/x" });
    expect((ctx as any).autoSelectCurrentRepoIfSingleConfig).toHaveBeenCalled();
  });

  it("does not invoke auto-select when repoName is explicitly passed on a path-based handler", async () => {
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/x", branch: "x" }]),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({ isClean: true, reasons: [] }),
      },
    });
    await invoke(handleGetWorktreeStatus, ctx, { path: "/w/x", repoName: "explicit" });
    expect((ctx as any).autoSelectCurrentRepoIfSingleConfig).not.toHaveBeenCalled();
  });

  it("accepts the clone-mode checkout path from the service worktree list", async () => {
    const { ctx, git, service } = makeCtx({
      service: {
        isCloneMode: vi.fn<any>().mockReturnValue(true),
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/repo/clone", branch: "main" }]),
      },
      git: {
        getWorktrees: vi.fn<any>().mockRejectedValue(new Error("bare repo missing")),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({
          isClean: true,
          reasons: [],
        }),
      },
    });

    const result = await invoke(handleGetWorktreeStatus, ctx, { path: "/repo/clone" });
    const body = parseResponse(result);

    expect(body.path).toBe("/repo/clone");
    expect(body.isClean).toBe(true);
    expect(service.getWorktrees).toHaveBeenCalled();
    expect(git.getWorktrees).not.toHaveBeenCalled();
  });
});

describe("handleLoadConfig", () => {
  it("returns error when no configPath, env var, or discoverable config exists", async () => {
    const oldEnv = process.env.SYNC_WORKTREES_CONFIG;
    delete process.env.SYNC_WORKTREES_CONFIG;

    try {
      const { ctx } = makeCtx({});
      const result = await invoke(handleLoadConfig, ctx, {});
      const body = parseResponse(result);
      expect(body.error).toBe(true);
      expect(body.message).toContain("detect_context");
    } finally {
      if (oldEnv !== undefined) process.env.SYNC_WORKTREES_CONFIG = oldEnv;
    }
  });

  it("reuses an already detected config path", async () => {
    const oldEnv = process.env.SYNC_WORKTREES_CONFIG;
    delete process.env.SYNC_WORKTREES_CONFIG;

    try {
      const { ctx } = makeCtx({ configPath: "/workspace/sync-worktrees.config.js" });
      const result = await invoke(handleLoadConfig, ctx, {});
      const body = parseResponse(result);

      expect(body.error).toBeUndefined();
      expect(ctx.loadConfig).toHaveBeenCalledWith("/workspace/sync-worktrees.config.js");
      expect(ctx.detectFromPath).not.toHaveBeenCalled();
    } finally {
      if (oldEnv !== undefined) process.env.SYNC_WORKTREES_CONFIG = oldEnv;
    }
  });

  it("auto-detects config from launch CWD when no config is already known", async () => {
    const oldEnv = process.env.SYNC_WORKTREES_CONFIG;
    delete process.env.SYNC_WORKTREES_CONFIG;

    try {
      const { ctx } = makeCtx({
        discovered: makeDiscovered({ configPath: "/workspace/sync-worktrees.config.js" }),
        launchCwd: "/workspace/repo/main",
      });
      const result = await invoke(handleLoadConfig, ctx, {});
      const body = parseResponse(result);

      expect(body.error).toBeUndefined();
      expect(ctx.detectFromPath).toHaveBeenCalledWith("/workspace/repo/main");
      expect(ctx.loadConfig).toHaveBeenCalledWith("/workspace/sync-worktrees.config.js");
    } finally {
      if (oldEnv !== undefined) process.env.SYNC_WORKTREES_CONFIG = oldEnv;
    }
  });

  it("surfaces the real parse error when detection finds a config that fails to load", async () => {
    const oldEnv = process.env.SYNC_WORKTREES_CONFIG;
    delete process.env.SYNC_WORKTREES_CONFIG;

    try {
      // detectFromPath only records configs that loaded successfully, so a
      // found-but-broken config is only reachable via the findConfigUpward
      // fallback — without it the user would get the unhelpful generic
      // "configPath required" message instead of the parse error.
      const { ctx } = makeCtx({
        launchCwd: "/workspace/repo/main",
        loadConfigImpl: async () => {
          throw new Error("Unexpected token '}' in sync-worktrees.config.js");
        },
      });
      (ctx as any).findConfigUpward.mockResolvedValue("/workspace/sync-worktrees.config.js");

      const result = await invoke(handleLoadConfig, ctx, {});
      const body = parseResponse(result);

      expect(body.error).toBe(true);
      expect(body.message).toContain("Unexpected token");
      expect(body.message).not.toContain("configPath required");
      expect(ctx.loadConfig).toHaveBeenCalledWith("/workspace/sync-worktrees.config.js");
    } finally {
      if (oldEnv !== undefined) process.env.SYNC_WORKTREES_CONFIG = oldEnv;
    }
  });

  it("loads from explicit path", async () => {
    const { ctx } = makeCtx({ loadConfigImpl: async () => [] });
    const result = await invoke(handleLoadConfig, ctx, { configPath: "/tmp/config.js" });
    const body = parseResponse(result);
    expect(body.error).toBeUndefined();
    expect(body.configPath).toContain("config.js");
  });
});

describe("handleSetCurrentRepository", () => {
  it("switches current repo and returns list", async () => {
    const { ctx } = makeCtx({});
    const result = await invoke(handleSetCurrentRepository, ctx, { repoName: "other" });
    const body = parseResponse(result);
    expect(body.error).toBeUndefined();
    expect(ctx.setCurrentRepo).toHaveBeenCalledWith("other");
  });

  it("surfaces errors from setCurrentRepo", async () => {
    const { ctx } = makeCtx({});
    (ctx.setCurrentRepo as any).mockImplementation(() => {
      throw new Error("Repository 'missing' not found");
    });
    const result = await invoke(handleSetCurrentRepository, ctx, { repoName: "missing" });
    const body = parseResponse(result);
    expect(body.error).toBe(true);
    expect(body.message).toContain("missing");
  });
});

describe("handleInitialize", () => {
  it("initializes service and returns repo defaults", async () => {
    const { ctx, service, git } = makeCtx({});
    service.config.worktreeDir = "/repo/worktrees";
    git.getDefaultBranch.mockReturnValue("main");

    const result = await invoke(handleInitialize, ctx, {});
    const body = parseResponse(result);

    expect(body.success).toBe(true);
    expect(body.defaultBranch).toBe("main");
    expect(body.worktreeDir).toBe("/repo/worktrees");
    expect(service.runExclusiveRepoOperation).toHaveBeenCalledTimes(1);
    expect(service.initializeUnlocked).toHaveBeenCalled();
  });
});

describe("list_worktrees lastSyncAt", () => {
  it("surfaces lastSyncDate from metadata as lastSyncAt", async () => {
    const iso = "2026-04-19T10:00:00.000Z";
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/repo/main", branch: "main", isCurrent: true }]),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({
          isClean: true,
          hasUnpushedCommits: false,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: true,
          reasons: [],
        }),
        getWorktreeMetadata: vi.fn<any>().mockResolvedValue({ lastSyncDate: iso }),
      },
    });

    const result = await invoke(handleListWorktrees, ctx, {});
    const body = parseResponse(result);
    expect(body.worktrees[0].lastSyncAt).toBe(iso);
  });

  it("returns null lastSyncAt when metadata missing", async () => {
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/repo/main", branch: "main", isCurrent: true }]),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({
          isClean: true,
          hasUnpushedCommits: false,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: true,
          reasons: [],
        }),
      },
    });

    const result = await invoke(handleListWorktrees, ctx, {});
    const body = parseResponse(result);
    expect(body.worktrees[0].lastSyncAt).toBeNull();
  });
});

describe("handleListWorktrees fallbacks", () => {
  it("falls back to discovered worktrees when git.getWorktrees fails", async () => {
    const { ctx, git } = makeCtx({
      discovered: makeDiscovered({
        currentWorktreePath: "/repo/main",
        allWorktrees: [
          { path: "/repo/main", branch: "main", isCurrent: true },
          { path: "/repo/worktrees/feature", branch: "feature", isCurrent: false },
        ],
      }),
      git: {
        getWorktrees: vi.fn<any>().mockRejectedValue(new Error("git unavailable")),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({
          isClean: true,
          hasUnpushedCommits: false,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: true,
          reasons: [],
        }),
      },
    });

    const result = await invoke(handleListWorktrees, ctx, {});
    const body = parseResponse(result);

    expect(body.worktrees).toHaveLength(2);
    expect(body.worktrees[0].isCurrent).toBe(true);
    expect(body.worktrees[1].branch).toBe("feature");
    expect(git.getFullWorktreeStatus).toHaveBeenCalledTimes(2);
  });

  it("returns an empty list when service lookup succeeds but no worktrees are available", async () => {
    const { ctx } = makeCtx({
      discovered: null,
      git: {
        getWorktrees: vi.fn<any>().mockRejectedValue(new Error("git unavailable")),
      },
    });

    const result = await invoke(handleListWorktrees, ctx, {});
    const body = parseResponse(result);

    expect(body.worktrees).toEqual([]);
  });
});

describe("handleCreateWorktree collisions", () => {
  it("produces distinct paths for collision-prone branch names", async () => {
    const { ctx, git } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: true, remote: true }),
      },
    });

    await invoke(handleCreateWorktree, ctx, { branchName: "feature/x" });
    const firstPath = (git.addWorktree as any).mock.calls[0][1];

    (git.addWorktree as any).mockClear();
    await invoke(handleCreateWorktree, ctx, { branchName: "feature-x" });
    const secondPath = (git.addWorktree as any).mock.calls[0][1];

    expect(firstPath).not.toBe(secondPath);
  });
});

describe("handleCreateWorktree target path guard", () => {
  // The same sanitized (hash-suffixed) path the handler derives for the branch.
  const targetPath = new PathResolutionService().getBranchWorktreePath("/repo/worktrees", "feature/x");

  it("refuses when the target path exists on disk but is not a registered worktree", async () => {
    const { ctx, git } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: true, remote: true }),
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/repo/worktrees/main", branch: "main" }]),
      },
    });
    fsMock.access.mockResolvedValueOnce(undefined);

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "feature/x" });
    const body = parseResponse(result);

    expect(result.isError).toBe(true);
    expect(body.code).toBe("TARGET_EXISTS");
    expect(body.message).toContain(targetPath);
    expect(body.message).toContain("not a registered worktree");
    expect(fsMock.access).toHaveBeenCalledWith(targetPath);
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

  it("refuses before creating a new branch when the target path is occupied", async () => {
    const { ctx, git } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: false, remote: false }),
      },
    });
    fsMock.access.mockResolvedValueOnce(undefined);

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "feature/x", baseBranch: "main" });
    const body = parseResponse(result);

    expect(body.code).toBe("TARGET_EXISTS");
    // Refusing after createBranch would leave an unpushed local branch behind
    // that a retry (after cleanup) then checks out without ever pushing.
    expect(git.createBranch).not.toHaveBeenCalled();
    expect(git.addWorktree).not.toHaveBeenCalled();
    expect(git.pushBranch).not.toHaveBeenCalled();
  });

  it("refuses when the target path cannot be probed", async () => {
    const { ctx, git } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: true, remote: true }),
      },
    });
    fsMock.access.mockRejectedValueOnce(errno("EACCES"));

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "feature/x" });
    const body = parseResponse(result);

    expect(body.error).toBe(true);
    expect(body.message).toContain("Cannot verify");
    expect(body.message).toContain(targetPath);
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

  it("proceeds to addWorktree when nothing exists at the target path", async () => {
    const { ctx, git } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: true, remote: true }),
      },
    });
    fsMock.access.mockRejectedValueOnce(errno("ENOENT"));

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "feature/x" });
    const body = parseResponse(result);

    expect(body.success).toBe(true);
    expect(fsMock.access).toHaveBeenCalledWith(targetPath);
    expect(git.addWorktree).toHaveBeenCalledWith("feature/x", targetPath);
  });

  it("skips the disk probe when the path is already registered for the same branch", async () => {
    const { ctx, git } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: true, remote: true }),
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: targetPath, branch: "feature/x" }]),
      },
    });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "feature/x" });
    const body = parseResponse(result);

    expect(body.success).toBe(true);
    expect(fsMock.access).not.toHaveBeenCalled();
    expect(git.addWorktree).toHaveBeenCalledWith("feature/x", targetPath);
  });
});

describe("handleListWorktrees includeSize", () => {
  it("returns sizeBytes when includeSize=true", async () => {
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/repo/main", branch: "main", isCurrent: true }]),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({
          isClean: true,
          hasUnpushedCommits: false,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: true,
          reasons: [],
        }),
      },
    });

    const result = await invoke(handleListWorktrees, ctx, { includeSize: true });
    const body = parseResponse(result);
    expect(body.worktrees[0].sizeBytes).toBe(123456);
  });
});

describe("handleListWorktrees structured safeToRemove", () => {
  it("returns unsafe with joined reasons when canRemove=false", async () => {
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/repo/feat", branch: "feat" }]),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({
          isClean: false,
          hasUnpushedCommits: true,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: false,
          reasons: ["uncommitted changes", "unpushed commits"],
        }),
      },
    });

    const result = await invoke(handleListWorktrees, ctx, {});
    const body = parseResponse(result);
    expect(body.worktrees[0].safeToRemove.safe).toBe(false);
    expect(body.worktrees[0].safeToRemove.reason).toContain("uncommitted changes");
  });

  it("returns unsafe + 'deleted upstream' reason when upstream gone", async () => {
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/repo/feat", branch: "feat" }]),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({
          isClean: true,
          hasUnpushedCommits: false,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: true,
          canRemove: true,
          reasons: [],
        }),
      },
    });

    const result = await invoke(handleListWorktrees, ctx, {});
    const body = parseResponse(result);
    expect(body.worktrees[0].safeToRemove.safe).toBe(false);
    expect(body.worktrees[0].safeToRemove.reason).toContain("deleted upstream");
  });
});

describe("handleDetectContext includeStatus", () => {
  it("returns allWorktrees as-is when includeStatus is false/omitted", async () => {
    const ctx = {
      detectFromPath: vi.fn<any>().mockResolvedValue(
        makeDiscovered({
          allWorktrees: [
            { path: "/repo/main", branch: "main", isCurrent: true },
            { path: "/repo/feat", branch: "feat", isCurrent: false },
          ],
        }),
      ),
      getConfiguredRepositorySummaries: vi.fn<any>().mockResolvedValue([]),
    } as unknown as RepositoryContext;

    const result = await invoke(handleDetectContext, ctx, {});
    const body = parseResponse(result);
    expect(body.allWorktrees[0].label).toBeUndefined();
    expect(body.allWorktrees[1].divergence).toBeUndefined();
    expect(body.configuredRepositories).toEqual([]);
  });

  it("enriches allWorktrees with label/divergence/staleHint when includeStatus=true", async () => {
    const ctx = {
      detectFromPath: vi.fn<any>().mockResolvedValue(
        makeDiscovered({
          allWorktrees: [
            { path: "/repo/main", branch: "main", isCurrent: true },
            { path: "/repo/feat", branch: "feat", isCurrent: false },
          ],
        }),
      ),
      getConfiguredRepositorySummaries: vi.fn<any>().mockResolvedValue([]),
    } as unknown as RepositoryContext;

    const result = await invoke(handleDetectContext, ctx, { includeStatus: true });
    const body = parseResponse(result);
    expect(body.allWorktrees[0].label).toBe("current");
    expect(body.allWorktrees[1].label).toBe("clean");
    expect(body.allWorktrees[0].staleHint).toBe(false);
  });

  it("returns lean mode-discriminated configured repository setup by default", async () => {
    const configuredRepositorySummaries = [
      { name: "ui", mode: "clone", checkoutPath: "/workspace/ui", isCurrent: false },
      { name: "frontend", mode: "worktree", worktreeDir: "/workspace/frontend", isCurrent: true },
    ];
    const { ctx } = makeCtx({ configuredRepositorySummaries });

    const result = await invoke(handleDetectContext, ctx, {});
    const body = parseResponse(result);

    expect(body.configuredRepositories).toEqual(configuredRepositorySummaries);
    expect(ctx.getConfiguredRepositorySummaries).toHaveBeenCalledWith({ detailed: false });
  });

  it("returns detailed configured repository setup when detailed=true", async () => {
    const configuredRepositorySummaries = [
      {
        name: "frontend",
        mode: "worktree",
        worktreeDir: "/workspace/frontend",
        repoUrl: "https://github.com/test/frontend.git",
        bareRepoDir: "/workspace/.bare/frontend",
        isCurrent: true,
        localReady: true,
      },
    ];
    const { ctx } = makeCtx({ configuredRepositorySummaries });

    const result = await invoke(handleDetectContext, ctx, { detailed: true });
    const body = parseResponse(result);

    expect(body.configuredRepositories).toEqual(configuredRepositorySummaries);
    expect(ctx.getConfiguredRepositorySummaries).toHaveBeenCalledWith({ detailed: true });
  });

  it("returns server-wide configuredRepositories regardless of params.path", async () => {
    const configuredRepositorySummaries = [
      { name: "ui", mode: "clone", checkoutPath: "/workspace/ui", isCurrent: true },
      { name: "frontend", mode: "worktree", worktreeDir: "/workspace/frontend", isCurrent: false },
    ];
    const { ctx } = makeCtx({ configuredRepositorySummaries });

    const result = await invoke(handleDetectContext, ctx, { path: "/tmp/some-foreign-checkout" });
    const body = parseResponse(result);

    expect(body.configuredRepositories).toEqual(configuredRepositorySummaries);
    expect(ctx.getConfiguredRepositorySummaries).toHaveBeenCalledWith({ detailed: false });
  });

  it("adds allWorktreesByRepo when includeAllWorktrees=true", async () => {
    const { ctx } = makeCtx({
      discovered: makeDiscovered({
        currentWorktreePath: "/repo/main",
        allWorktrees: [{ path: "/repo/main", branch: "main", isCurrent: true }],
      }),
      allConfiguredWorktrees: {
        test: [{ path: "/repo/main", branch: "main", isCurrent: true }],
        other: [{ path: "/other/feature", branch: "feature", isCurrent: false }],
      },
    });

    const result = await invoke(handleDetectContext, ctx, { includeAllWorktrees: true });
    const body = parseResponse(result);

    expect(body.allWorktreesByRepo).toEqual({
      test: [{ path: "/repo/main", branch: "main", isCurrent: true }],
      other: [{ path: "/other/feature", branch: "feature", isCurrent: false }],
    });
    expect(ctx.getAllConfiguredWorktreeDetails).toHaveBeenCalledWith("/repo/main");
  });

  it("enriches allWorktreesByRepo and returns per-repo errors when both include flags are true", async () => {
    const { ctx } = makeCtx({
      discovered: makeDiscovered({
        currentWorktreePath: "/repo/main",
        allWorktrees: [{ path: "/repo/main", branch: "main", isCurrent: true }],
      }),
      allConfiguredWorktrees: {
        test: [{ path: "/repo/main", branch: "main", isCurrent: true }],
        other: [{ path: "/other/feature", branch: "feature", isCurrent: false }],
      },
      allConfiguredWorktreeErrors: {
        broken: "git worktree list failed",
      },
    });

    const result = await invoke(handleDetectContext, ctx, { includeAllWorktrees: true, includeStatus: true });
    const body = parseResponse(result);

    expect(body.allWorktrees[0]).toMatchObject({ path: "/repo/main", label: "current", staleHint: false });
    expect(body.allWorktreesByRepo.test[0]).toMatchObject({ path: "/repo/main", label: "current", staleHint: false });
    expect(body.allWorktreesByRepo.other[0]).toMatchObject({
      path: "/other/feature",
      label: "clean",
      staleHint: false,
    });
    expect(body.allWorktreeErrorsByRepo).toEqual({ broken: "git worktree list failed" });
  });
});

describe("credential redaction in tool responses", () => {
  const TOKEN_URL = "https://ci-bot:s3cr3t-token@github.com/test/repo.git";
  const REDACTED_URL = "https://***@github.com/test/repo.git";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detect_context never echoes credentials from repoUrl, siblings, configured repositories or git errors", async () => {
    const { ctx } = makeCtx({
      discovered: makeDiscovered({
        repoUrl: TOKEN_URL,
        siblingRepositories: [
          {
            name: "sib",
            bareRepoPath: "/ws/sib/.bare",
            worktreeDir: "/ws/sib/worktrees",
            repoUrl: TOKEN_URL,
            present: true,
            configMatched: true,
          },
        ],
        notes: [`Failed to read bare repo at /ws/.bare: fatal: unable to access '${TOKEN_URL}/': 403`],
      }),
      configuredRepositorySummaries: [
        {
          name: "frontend",
          mode: "worktree",
          worktreeDir: "/ws/frontend",
          repoUrl: TOKEN_URL,
          bareRepoDir: "/ws/.bare/frontend",
          isCurrent: true,
          localReady: true,
        },
      ],
      allConfiguredWorktreeErrors: { frontend: `fatal: could not read from remote repository ${TOKEN_URL}` },
    });

    const result = await invoke(handleDetectContext, ctx, { detailed: true, includeAllWorktrees: true });
    const body = parseResponse(result);

    expect(body.repoUrl).toBe(REDACTED_URL);
    expect(body.siblingRepositories[0].repoUrl).toBe(REDACTED_URL);
    expect(body.configuredRepositories[0].repoUrl).toBe(REDACTED_URL);
    expect(body.notes[0]).toBe(
      `Failed to read bare repo at /ws/.bare: fatal: unable to access '${REDACTED_URL}/': 403`,
    );
    expect(body.allWorktreeErrorsByRepo.frontend).toBe(`fatal: could not read from remote repository ${REDACTED_URL}`);
    expect((result.content[0] as { text: string }).text).not.toContain("s3cr3t-token");
  });

  it("load_config never echoes credentials from the repository list", async () => {
    const { ctx } = makeCtx({ configPath: "/ws/sync-worktrees.config.js" });
    vi.mocked(ctx.getRepositoryList).mockReturnValue([
      { name: "frontend", repoUrl: TOKEN_URL, worktreeDir: "/ws/frontend", source: "config" },
    ]);

    const result = await invoke(handleLoadConfig, ctx, { configPath: "/ws/sync-worktrees.config.js" });
    const body = parseResponse(result);

    expect(body.repositories).toEqual([
      { name: "frontend", repoUrl: REDACTED_URL, worktreeDir: "/ws/frontend", source: "config" },
    ]);
    expect((result.content[0] as { text: string }).text).not.toContain("s3cr3t-token");
  });

  it("sync turns a git error that quotes the remote URL into a redacted error response", async () => {
    const { ctx } = makeCtx({
      service: {
        sync: vi
          .fn<any>()
          .mockRejectedValue(
            new Error(`fatal: unable to access '${TOKEN_URL}/': The requested URL returned error: 403`),
          ),
      },
    });

    const result = await invoke(handleSync, ctx, {});
    const body = parseResponse(result);

    expect(result.isError).toBe(true);
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.message).toBe(`fatal: unable to access '${REDACTED_URL}/': The requested URL returned error: 403`);
    expect((result.content[0] as { text: string }).text).not.toContain("s3cr3t-token");
  });
});
