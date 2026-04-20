import { describe, expect, it, vi } from "vitest";

import {
  handleCreateWorktree,
  handleGetWorktreeStatus,
  handleInitialize,
  handleListWorktrees,
  handleLoadConfig,
  handleRemoveWorktree,
  handleSetCurrentRepository,
  handleSync,
  handleUpdateWorktree,
} from "../handlers";
import { formatErrorResponse } from "../utils";

import type { Capabilities, DiscoveredRepoContext, RepositoryContext } from "../context";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

async function invoke<T>(
  handler: (ctx: RepositoryContext, params: T, extra?: any) => Promise<CallToolResult>,
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

function makeCapabilities(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    canListWorktrees: true,
    canGetStatus: true,
    canCreateWorktree: true,
    canRemoveWorktree: true,
    canUpdateWorktree: true,
    canSync: true,
    canInitialize: true,
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
    configLoaded: true,
    repoName: "test",
    capabilities: makeCapabilities(),
    reasons: [],
    ...overrides,
  };
}

type MockGit = {
  getWorktrees: ReturnType<typeof vi.fn>;
  getFullWorktreeStatus: ReturnType<typeof vi.fn>;
  branchExists: ReturnType<typeof vi.fn>;
  createBranch: ReturnType<typeof vi.fn>;
  pushBranch: ReturnType<typeof vi.fn>;
  addWorktree: ReturnType<typeof vi.fn>;
  removeWorktree: ReturnType<typeof vi.fn>;
  updateWorktree: ReturnType<typeof vi.fn>;
  getDefaultBranch: ReturnType<typeof vi.fn>;
  getWorktreeMetadata: ReturnType<typeof vi.fn>;
};

function makeCtx(opts: {
  discovered?: DiscoveredRepoContext | null;
  git?: Partial<MockGit>;
  syncInProgress?: boolean;
  loadConfigImpl?: (configPath: string) => Promise<unknown>;
  currentRepo?: string;
}): { ctx: RepositoryContext; git: MockGit; service: any } {
  const git: MockGit = {
    getWorktrees: vi.fn<any>().mockResolvedValue([]),
    getFullWorktreeStatus: vi.fn<any>(),
    branchExists: vi.fn<any>(),
    createBranch: vi.fn<any>(),
    pushBranch: vi.fn<any>(),
    addWorktree: vi.fn<any>(),
    removeWorktree: vi.fn<any>(),
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
    sync: vi.fn<any>().mockResolvedValue(undefined),
    getGitService: () => git,
  };

  const ctx = {
    getDiscoveredContext: vi.fn<any>().mockReturnValue(opts.discovered ?? makeDiscovered()),
    getEntry: vi.fn<any>().mockReturnValue({
      name: opts.currentRepo ?? "test",
      service,
    }),
    getService: vi.fn<any>().mockResolvedValue(service),
    loadConfig: vi.fn<any>().mockImplementation((opts.loadConfigImpl ?? (async () => [])) as any),
    getCurrentRepo: vi.fn<any>().mockReturnValue(opts.currentRepo ?? "test"),
    getRepositoryList: vi.fn<any>().mockReturnValue([]),
    setCurrentRepo: vi.fn<any>(),
  } as unknown as RepositoryContext;

  return { ctx, git, service };
}

function parseResponse(result: any): any {
  return JSON.parse(result.content[0].text);
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
    expect(body.worktrees[1].safeToRemove).toBe(true);
    expect(git.getWorktrees).toHaveBeenCalled();
  });

  it("fails with CAPABILITY_UNAVAILABLE when canListWorktrees is false", async () => {
    const { ctx } = makeCtx({
      discovered: makeDiscovered({
        capabilities: makeCapabilities({ canListWorktrees: false }),
        reasons: ["test reason"],
      }),
    });

    const result = await invoke(handleListWorktrees, ctx, {});
    const body = parseResponse(result);
    expect(body.error).toBe(true);
    expect(body.code).toBe("CAPABILITY_UNAVAILABLE");
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

  it("creates branch when it does not exist and baseBranch provided", async () => {
    const { ctx, git } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: false, remote: false }),
      },
    });

    const result = await invoke(handleCreateWorktree, ctx, {
      branchName: "new-branch",
      baseBranch: "main",
      push: true,
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
    const { ctx } = makeCtx({ syncInProgress: true });
    const result = await invoke(handleCreateWorktree, ctx, { branchName: "x", baseBranch: "main" });
    const body = parseResponse(result);
    expect(body.code).toBe("SYNC_IN_PROGRESS");
  });
});

describe("handleRemoveWorktree", () => {
  it("refuses removal when worktree not clean and force=false", async () => {
    const { ctx, git } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/foo", branch: "x" }]),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({
          canRemove: false,
          reasons: ["has uncommitted changes"],
        }),
      },
    });

    const result = await invoke(handleRemoveWorktree, ctx, { path: "/foo" });
    const body = parseResponse(result);
    expect(body.error).toBe(true);
    expect(body.message).toContain("has uncommitted changes");
    expect(git.removeWorktree).not.toHaveBeenCalled();
  });

  it("skips safety check when force=true", async () => {
    const { ctx, git } = makeCtx({
      git: { getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/foo", branch: "x" }]) },
    });
    const result = await invoke(handleRemoveWorktree, ctx, { path: "/foo", force: true });
    const body = parseResponse(result);
    expect(body.success).toBe(true);
    expect(git.removeWorktree).toHaveBeenCalledWith("/foo");
  });

  it("rejects path not belonging to the repository", async () => {
    const { ctx, git } = makeCtx({
      git: { getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/repo/main", branch: "main", isCurrent: true }]) },
    });
    const result = await invoke(handleRemoveWorktree, ctx, { path: "/unrelated", force: true });
    const body = parseResponse(result);
    expect(body.error).toBe(true);
    expect(body.message).toContain("not a registered worktree");
    expect(git.removeWorktree).not.toHaveBeenCalled();
  });
});

describe("handleSync", () => {
  it("fails when canSync=false", async () => {
    const { ctx } = makeCtx({
      discovered: makeDiscovered({
        capabilities: makeCapabilities({ canSync: false }),
        reasons: ["no config"],
      }),
    });
    const result = await invoke(handleSync, ctx, {});
    const body = parseResponse(result);
    expect(body.code).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("calls service.sync and returns duration", async () => {
    const { ctx, service } = makeCtx({});
    const result = await invoke(handleSync, ctx, {});
    const body = parseResponse(result);
    expect(body.success).toBe(true);
    expect(typeof body.duration).toBe("number");
    expect(service.sync).toHaveBeenCalled();
  });

  it("initializes service before syncing when needed", async () => {
    const { ctx, service } = makeCtx({});
    service.isInitialized.mockReturnValue(false);

    const result = await invoke(handleSync, ctx, {});
    const body = parseResponse(result);

    expect(body.success).toBe(true);
    expect(service.initialize).toHaveBeenCalled();
    expect(service.sync).toHaveBeenCalled();
  });
});

describe("handleUpdateWorktree", () => {
  it("calls updateWorktree on given path", async () => {
    const { ctx, git } = makeCtx({
      git: { getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/feature", branch: "feature" }]) },
    });
    const result = await invoke(handleUpdateWorktree, ctx, { path: "/w/feature" });
    const body = parseResponse(result);
    expect(body.success).toBe(true);
    expect(git.updateWorktree).toHaveBeenCalledWith("/w/feature");
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
});

describe("handleLoadConfig", () => {
  it("returns error when no configPath and no env var", async () => {
    const oldEnv = process.env.SYNC_WORKTREES_CONFIG;
    delete process.env.SYNC_WORKTREES_CONFIG;

    const { ctx } = makeCtx({});
    const result = await invoke(handleLoadConfig, ctx, {});
    const body = parseResponse(result);
    expect(body.error).toBe(true);

    if (oldEnv !== undefined) process.env.SYNC_WORKTREES_CONFIG = oldEnv;
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
    expect(service.initialize).toHaveBeenCalled();
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
  it("errors when sanitized worktree path collides with another branch", async () => {
    const { ctx } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: true, remote: true }),
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/repo/worktrees/feature-x", branch: "feature-x-old" }]),
      },
    });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "feature/x" });
    const body = parseResponse(result);

    expect(body.error).toBe(true);
    expect(body.message).toContain("collides with existing branch");
  });
});
