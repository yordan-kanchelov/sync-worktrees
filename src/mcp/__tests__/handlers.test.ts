import { afterEach, describe, expect, it, vi } from "vitest";

import {
  handleCompareBranch,
  handleCreateWorktree,
  handleGetWorktreeStatus,
  handleInitialize,
  handleListBranches,
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
  isWorktreeLocked: ReturnType<typeof vi.fn>;
  getRemoteBranchesWithActivity: ReturnType<typeof vi.fn>;
  getLocalBranches: ReturnType<typeof vi.fn>;
  getCurrentCommit: ReturnType<typeof vi.fn>;
  getRemoteCommit: ReturnType<typeof vi.fn>;
  hasDivergedHistory: ReturnType<typeof vi.fn>;
  canFastForward: ReturnType<typeof vi.fn>;
  isLocalAheadOfRemote: ReturnType<typeof vi.fn>;
  compareTreeContent: ReturnType<typeof vi.fn>;
  getBranchDivergence: ReturnType<typeof vi.fn>;
  getDivergenceFromWorktree: ReturnType<typeof vi.fn>;
  getLocalCommit: ReturnType<typeof vi.fn>;
};

function makeCtx(opts: {
  discovered?: DiscoveredRepoContext | null;
  git?: Partial<MockGit>;
  syncInProgress?: boolean;
  loadConfigImpl?: (configPath: string) => Promise<unknown>;
  currentRepo?: string;
  config?: Record<string, unknown>;
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
    isWorktreeLocked: vi.fn<any>().mockResolvedValue({ locked: false, reason: null }),
    getRemoteBranchesWithActivity: vi.fn<any>().mockResolvedValue([]),
    getLocalBranches: vi.fn<any>().mockResolvedValue([]),
    getCurrentCommit: vi.fn<any>().mockResolvedValue("local-sha"),
    getRemoteCommit: vi.fn<any>().mockResolvedValue("remote-sha"),
    hasDivergedHistory: vi.fn<any>().mockResolvedValue(false),
    canFastForward: vi.fn<any>().mockResolvedValue(true),
    isLocalAheadOfRemote: vi.fn<any>().mockResolvedValue(false),
    compareTreeContent: vi.fn<any>().mockResolvedValue(true),
    getBranchDivergence: vi.fn<any>().mockResolvedValue({ ahead: 0, behind: 0 }),
    getDivergenceFromWorktree: vi.fn<any>().mockResolvedValue({ ahead: 0, behind: 0 }),
    getLocalCommit: vi.fn<any>().mockResolvedValue("local-sha"),
    ...opts.git,
  };

  const service = {
    config: { worktreeDir: "/repo/worktrees", ...(opts.config ?? {}) },
    isInitialized: vi.fn<any>().mockReturnValue(true),
    isSyncInProgress: vi.fn<any>().mockReturnValue(opts.syncInProgress ?? false),
    initialize: vi.fn<any>().mockResolvedValue(undefined),
    sync: vi.fn<any>().mockResolvedValue({ started: true }),
    getGitService: () => git,
    emit: vi.fn<any>(),
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
    invalidateDiscovered: vi.fn<any>(),
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

  it("includes pendingWork when includePendingDetails=true", async () => {
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/feature", branch: "feature" }]),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({
          isClean: false,
          hasUnpushedCommits: true,
          hasStashedChanges: true,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: false,
          reasons: ["uncommitted changes"],
          details: {
            modifiedFiles: 3,
            deletedFiles: 1,
            renamedFiles: 0,
            createdFiles: 2,
            conflictedFiles: 0,
            untrackedFiles: 4,
            unpushedCommitCount: 7,
            stashCount: 2,
          },
        }),
      },
    });

    const result = await invoke(handleListWorktrees, ctx, { includePendingDetails: true });
    const body = parseResponse(result);
    expect(body.worktrees[0].pendingWork).toEqual({
      dirtyFiles: 6,
      untrackedCount: 4,
      unpushedCommits: 7,
      stashes: 2,
    });
  });

  it("returns null pendingWork counts when underlying git query failed but flag is set", async () => {
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/y", branch: "y" }]),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({
          isClean: true,
          hasUnpushedCommits: true,
          hasStashedChanges: true,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: false,
          reasons: [],
          details: {
            modifiedFiles: 0,
            deletedFiles: 0,
            renamedFiles: 0,
            createdFiles: 0,
            conflictedFiles: 0,
            untrackedFiles: 0,
          },
        }),
      },
    });

    const result = await invoke(handleListWorktrees, ctx, { includePendingDetails: true });
    const body = parseResponse(result);
    expect(body.worktrees[0].pendingWork).toEqual({
      dirtyFiles: 0,
      untrackedCount: 0,
      unpushedCommits: null,
      stashes: null,
    });
  });

  it("omits pendingWork when includePendingDetails=false (default)", async () => {
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/x", branch: "x" }]),
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
    expect(body.worktrees[0].pendingWork).toBeUndefined();
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

describe("handleCompareBranch", () => {
  it("rejects when neither path nor branchName provided", async () => {
    const { ctx } = makeCtx({});
    const result = await invoke(handleCompareBranch, ctx, {});
    const body = parseResponse(result);
    expect(body.error).toBe(true);
    expect(body.message).toContain("Provide one of");
  });

  it("rejects when both path and branchName provided", async () => {
    const { ctx } = makeCtx({});
    const result = await invoke(handleCompareBranch, ctx, { path: "/w/x", branchName: "x" });
    const body = parseResponse(result);
    expect(body.error).toBe(true);
  });

  it("path mode: returns up-to-date verdict for clean tree-equal worktree", async () => {
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/main", branch: "main" }]),
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
        compareTreeContent: vi.fn<any>().mockResolvedValue(true),
        canFastForward: vi.fn<any>().mockResolvedValue(true),
      },
    });

    const result = await invoke(handleCompareBranch, ctx, { path: "/w/main" });
    const body = parseResponse(result);
    expect(body.verdict).toBe("up-to-date");
    expect(body.mode).toBe("path");
    expect(body.branch).toBe("main");
  });

  it("path mode: would-lose-work when dirty", async () => {
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/x", branch: "x" }]),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({
          isClean: false,
          hasUnpushedCommits: false,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: false,
          reasons: ["uncommitted changes"],
        }),
      },
    });

    const result = await invoke(handleCompareBranch, ctx, { path: "/w/x" });
    const body = parseResponse(result);
    expect(body.verdict).toBe("would-lose-work");
    expect(body.reasons).toContain("uncommitted changes");
  });

  it("path mode: safe-to-remove when upstream gone and clean", async () => {
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/old", branch: "old" }]),
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

    const result = await invoke(handleCompareBranch, ctx, { path: "/w/old" });
    const body = parseResponse(result);
    expect(body.verdict).toBe("safe-to-remove");
    expect(body.upstreamGone).toBe(true);
  });

  it("branchName mode: up-to-date when SHAs match", async () => {
    const { ctx } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: true, remote: true }),
        getWorktrees: vi.fn<any>().mockResolvedValue([]),
        getLocalCommit: vi.fn<any>().mockResolvedValue("same-sha"),
        getRemoteCommit: vi.fn<any>().mockResolvedValue("same-sha"),
        getBranchDivergence: vi.fn<any>().mockResolvedValue({ ahead: 0, behind: 0 }),
      },
    });
    const result = await invoke(handleCompareBranch, ctx, { branchName: "main" });
    const body = parseResponse(result);
    expect(body.verdict).toBe("up-to-date");
    expect(body.mode).toBe("branch");
    expect(body.hasWorktree).toBe(false);
  });

  it("branchName mode: can-fast-forward when behind", async () => {
    const { ctx } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: true, remote: true }),
        getWorktrees: vi.fn<any>().mockResolvedValue([]),
        getLocalCommit: vi.fn<any>().mockResolvedValue("local-sha"),
        getRemoteCommit: vi.fn<any>().mockResolvedValue("remote-sha"),
        getBranchDivergence: vi.fn<any>().mockResolvedValue({ ahead: 0, behind: 3 }),
      },
    });
    const result = await invoke(handleCompareBranch, ctx, { branchName: "main" });
    const body = parseResponse(result);
    expect(body.verdict).toBe("can-fast-forward");
    expect(body.behind).toBe(3);
  });

  it("branchName mode: diverged when ahead and behind", async () => {
    const { ctx } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: true, remote: true }),
        getWorktrees: vi.fn<any>().mockResolvedValue([]),
        getLocalCommit: vi.fn<any>().mockResolvedValue("local-sha"),
        getRemoteCommit: vi.fn<any>().mockResolvedValue("remote-sha"),
        getBranchDivergence: vi.fn<any>().mockResolvedValue({ ahead: 2, behind: 5 }),
      },
    });
    const result = await invoke(handleCompareBranch, ctx, { branchName: "feature" });
    const body = parseResponse(result);
    expect(body.verdict).toBe("diverged-needs-review");
  });

  it("branchName mode: no-local-branch when only remote exists", async () => {
    const { ctx } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: false, remote: true }),
        getWorktrees: vi.fn<any>().mockResolvedValue([]),
      },
    });
    const result = await invoke(handleCompareBranch, ctx, { branchName: "remote-only" });
    const body = parseResponse(result);
    expect(body.verdict).toBe("no-local-branch");
  });

  it("branchName mode: errors when branch not found anywhere", async () => {
    const { ctx } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: false, remote: false }),
        getWorktrees: vi.fn<any>().mockResolvedValue([]),
      },
    });
    const result = await invoke(handleCompareBranch, ctx, { branchName: "ghost" });
    const body = parseResponse(result);
    expect(body.error).toBe(true);
  });

  it("path mode: local-ahead verdict when clean and ahead-only with known divergence", async () => {
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/feat", branch: "feat" }]),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({
          isClean: true,
          hasUnpushedCommits: true,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          canRemove: false,
          reasons: ["has unpushed commits"],
        }),
        compareTreeContent: vi.fn<any>().mockResolvedValue(false),
        getDivergenceFromWorktree: vi.fn<any>().mockResolvedValue({ ahead: 3, behind: 0 }),
      },
    });

    const result = await invoke(handleCompareBranch, ctx, { path: "/w/feat" });
    const body = parseResponse(result);
    expect(body.verdict).toBe("local-ahead");
    expect(body.ahead).toBe(3);
  });

  it("path mode: diverged-needs-review when divergence cannot be computed and trees differ", async () => {
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/local-only", branch: "local-only" }]),
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
        compareTreeContent: vi.fn<any>().mockResolvedValue(false),
        getDivergenceFromWorktree: vi.fn<any>().mockResolvedValue(null),
      },
    });

    const result = await invoke(handleCompareBranch, ctx, { path: "/w/local-only" });
    const body = parseResponse(result);
    expect(body.verdict).toBe("diverged-needs-review");
    expect(body.reasons).toContain("could not compute divergence");
  });
});

describe("handleListBranches", () => {
  it("returns enriched remote + local with hasWorktree + config filter info", async () => {
    const now = new Date("2025-01-15T12:00:00Z");
    const { ctx } = makeCtx({
      config: { branchInclude: ["feature/*"], branchExclude: ["feature/legacy"] },
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/feature-a", branch: "feature/a" }]),
        getRemoteBranchesWithActivity: vi.fn<any>().mockResolvedValue([
          { branch: "feature/a", lastActivity: now },
          { branch: "feature/legacy", lastActivity: now },
          { branch: "hotfix/x", lastActivity: now },
        ]),
        getLocalBranches: vi.fn<any>().mockResolvedValue(["feature/a", "main"]),
      },
    });

    const result = await invoke(handleListBranches, ctx, {});
    const body = parseResponse(result);

    expect(body.configFiltersApplied).toBe(true);
    expect(body.remote).toHaveLength(3);
    const featureA = body.remote.find((r: any) => r.name === "feature/a");
    expect(featureA).toMatchObject({ hasWorktree: true, matchesConfigFilter: true });
    const legacy = body.remote.find((r: any) => r.name === "feature/legacy");
    expect(legacy.matchesConfigFilter).toBe(false);
    const hotfix = body.remote.find((r: any) => r.name === "hotfix/x");
    expect(hotfix.matchesConfigFilter).toBe(false);

    expect(body.branchesFilteredByConfig.sort()).toEqual(["feature/legacy", "hotfix/x"].sort());
    expect(body.branchesWithoutWorktrees).toEqual([]);

    expect(body.local).toEqual([
      { name: "feature/a", hasWorktree: true },
      { name: "main", hasWorktree: false },
    ]);
  });

  it("identifies branches without worktrees", async () => {
    const now = new Date();
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/main", branch: "main" }]),
        getRemoteBranchesWithActivity: vi.fn<any>().mockResolvedValue([
          { branch: "main", lastActivity: now },
          { branch: "needs-wt", lastActivity: now },
        ]),
      },
    });

    const result = await invoke(handleListBranches, ctx, { scope: "remote" });
    const body = parseResponse(result);
    expect(body.branchesWithoutWorktrees).toEqual(["needs-wt"]);
    expect(body.local).toEqual([]);
  });

  it("skips config filter when applyConfigFilters=false", async () => {
    const now = new Date();
    const { ctx } = makeCtx({
      config: { branchInclude: ["feature/*"] },
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([]),
        getRemoteBranchesWithActivity: vi.fn<any>().mockResolvedValue([{ branch: "hotfix/x", lastActivity: now }]),
      },
    });

    const result = await invoke(handleListBranches, ctx, { applyConfigFilters: false });
    const body = parseResponse(result);
    expect(body.configFiltersApplied).toBe(false);
    expect(body.branchesWithoutWorktrees).toEqual(["hotfix/x"]);
    expect(body.branchesFilteredByConfig).toEqual([]);
  });

  it("matchesConfigFilter reflects config truth even when applyConfigFilters=false", async () => {
    const now = new Date();
    const { ctx } = makeCtx({
      config: { branchInclude: ["feature/*"] },
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([]),
        getRemoteBranchesWithActivity: vi.fn<any>().mockResolvedValue([
          { branch: "feature/a", lastActivity: now },
          { branch: "hotfix/x", lastActivity: now },
        ]),
      },
    });

    const result = await invoke(handleListBranches, ctx, { applyConfigFilters: false });
    const body = parseResponse(result);
    const feature = body.remote.find((r: any) => r.name === "feature/a");
    const hotfix = body.remote.find((r: any) => r.name === "hotfix/x");
    expect(feature.matchesConfigFilter).toBe(true);
    expect(hotfix.matchesConfigFilter).toBe(false);
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
      push: true,
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
      push: true,
    });

    expect(callOrder).toEqual(["createBranch", "addWorktree", "pushBranch"]);
    expect(git.addWorktree).toHaveBeenCalled();
    expect(git.pushBranch).toHaveBeenCalledWith("new-branch");
  });
});

describe("create/update/remove progress notifications", () => {
  function makeProgressHarness() {
    const { ctx, service, git } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: false, remote: true }),
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/repo/worktrees/feature", branch: "feature" }]),
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

    const progressListeners: Array<(e: any) => void> = [];
    (service as any).onProgress = vi.fn<any>().mockImplementation((listener: any) => {
      progressListeners.push(listener);
      return () => {
        const idx = progressListeners.indexOf(listener);
        if (idx >= 0) progressListeners.splice(idx, 1);
      };
    });
    (service as any).emit = vi.fn<any>().mockImplementation((e: any) => {
      for (const l of progressListeners) l(e);
    });

    const sendNotification = vi.fn<any>().mockResolvedValue(undefined);
    const extra = { _meta: { progressToken: "p-1" }, sendNotification };
    return { ctx, service, git, sendNotification, extra };
  }

  it("create_worktree emits progress events", async () => {
    const { ctx, sendNotification, extra } = makeProgressHarness();
    await handleCreateWorktree(ctx, { branchName: "feature" }, extra as any);
    expect(sendNotification).toHaveBeenCalled();
    const messages = sendNotification.mock.calls.map((c: any) => c[0].params.message as string);
    expect(messages.some((m) => m.includes("[create]"))).toBe(true);
  });

  it("update_worktree emits progress events", async () => {
    const { ctx, sendNotification, extra } = makeProgressHarness();
    await handleUpdateWorktree(ctx, { path: "/repo/worktrees/feature" }, extra as any);
    const messages = sendNotification.mock.calls.map((c: any) => c[0].params.message as string);
    expect(messages.some((m) => m.includes("[update]"))).toBe(true);
  });

  it("remove_worktree emits progress events", async () => {
    const { ctx, sendNotification, extra } = makeProgressHarness();
    await handleRemoveWorktree(ctx, { path: "/repo/worktrees/feature" }, extra as any);
    const messages = sendNotification.mock.calls.map((c: any) => c[0].params.message as string);
    expect(messages.some((m) => m.includes("[remove]"))).toBe(true);
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
    expect(git.removeWorktree).toHaveBeenCalledWith("/foo", true);
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

  it("refuses removal when worktree is locked and force=false", async () => {
    const { ctx, git } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/foo", branch: "x" }]),
        isWorktreeLocked: vi.fn<any>().mockResolvedValue({ locked: true, reason: "on portable drive" }),
      },
    });
    const result = await invoke(handleRemoveWorktree, ctx, { path: "/foo" });
    const body = parseResponse(result);
    expect(body.error).toBe(true);
    expect(body.message).toContain("locked");
    expect(body.message).toContain("on portable drive");
    expect(git.removeWorktree).not.toHaveBeenCalled();
  });

  it("bypasses lock check when force=true", async () => {
    const { ctx, git } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/foo", branch: "x" }]),
        isWorktreeLocked: vi.fn<any>().mockResolvedValue({ locked: true, reason: "intentional" }),
      },
    });
    const result = await invoke(handleRemoveWorktree, ctx, { path: "/foo", force: true });
    const body = parseResponse(result);
    expect(body.success).toBe(true);
    expect(git.isWorktreeLocked).not.toHaveBeenCalled();
    expect(git.removeWorktree).toHaveBeenCalledWith("/foo", true);
  });

  it("forwards force=false to removeWorktree when not forcing", async () => {
    const { ctx, git } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/foo", branch: "x" }]),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({ canRemove: true, reasons: [] }),
      },
    });
    await invoke(handleRemoveWorktree, ctx, { path: "/foo" });
    expect(git.removeWorktree).toHaveBeenCalledWith("/foo", false);
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

  it("returns SYNC_IN_PROGRESS when sync returns started:false", async () => {
    const { ctx, service } = makeCtx({});
    service.sync.mockResolvedValue({ started: false, reason: "in_progress" });
    const result = await invoke(handleSync, ctx, {});
    const body = parseResponse(result);
    expect(body.code).toBe("SYNC_IN_PROGRESS");
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

    const sendNotification = vi.fn<any>().mockResolvedValue(undefined);
    const extra = { _meta: { progressToken: "tok-1" }, sendNotification };
    await handleSync(ctx, {}, extra as any);

    expect(sendNotification).toHaveBeenCalledTimes(2);
    const firstCall = sendNotification.mock.calls[0][0] as { params: { message: string } };
    const secondCall = sendNotification.mock.calls[1][0] as { params: { message: string } };
    expect(firstCall.params.message).toContain("[fetch]");
    expect(secondCall.params.message).toContain("[create]");
  });

  it("unsubscribes progress listener even when sync throws", async () => {
    const { ctx, service } = makeCtx({});
    const unsubscribe = vi.fn<any>();
    service.onProgress = vi.fn<any>().mockReturnValue(unsubscribe);
    service.sync.mockRejectedValue(new Error("boom"));

    const sendNotification = vi.fn<any>().mockResolvedValue(undefined);
    const extra = { _meta: { progressToken: "tok-1" }, sendNotification };
    await expect(handleSync(ctx, {}, extra as any)).rejects.toThrow("boom");
    expect(unsubscribe).toHaveBeenCalled();
  });
});

describe("handleInitialize", () => {
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
    service.initialize.mockImplementation(async () => {
      for (const l of progressListeners) l({ phase: "initialize", message: "Initializing repository" });
    });

    const sendNotification = vi.fn<any>().mockResolvedValue(undefined);
    const extra = { _meta: { progressToken: "init-1" }, sendNotification };
    await handleInitialize(ctx, {}, extra as any);

    expect(sendNotification).toHaveBeenCalled();
    const call = sendNotification.mock.calls[0][0] as { params: { message: string } };
    expect(call.params.message).toContain("[initialize]");
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
    expect(git.updateWorktree).toHaveBeenCalledWith("/users/foo/repo/feature");
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

  it("refuses update when worktree is locked", async () => {
    const { ctx, git } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/feature", branch: "feature" }]),
        isWorktreeLocked: vi.fn<any>().mockResolvedValue({ locked: true, reason: "manual hold" }),
      },
    });
    const result = await invoke(handleUpdateWorktree, ctx, { path: "/w/feature" });
    const body = parseResponse(result);
    expect(body.error).toBe(true);
    expect(body.message).toContain("locked");
    expect(body.message).toContain("manual hold");
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
