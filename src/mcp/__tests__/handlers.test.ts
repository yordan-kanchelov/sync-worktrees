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
import {
  createWorktreeOutputSchema,
  getWorktreeStatusOutputSchema,
  listWorktreesOutputSchema,
  syncOutputSchema,
} from "../output-schemas";
import { formatErrorResponse } from "../utils";
import { createMockLogger } from "../../__tests__/test-utils";
import { PathResolutionService } from "../../services/path-resolution.service";
import { makeGitProgressHandler } from "../../utils/git-progress";

import type { Capabilities, DiscoveredRepoContext, RepositoryContext } from "../context";
import type { ProgressEvent } from "../../services/progress-emitter";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { SimpleGitProgressEvent } from "simple-git";

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
    env: vi.fn<any>().mockReturnThis(),
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

// Every path the detect_context enrichment asked the status service about, in
// call order. One entry per git probe, so a path listed twice in the response
// shows up twice here unless the handler deduplicated it.
const statusProbes = vi.hoisted(() => [] as string[]);
// Paths whose status probe rejects, with the error it rejects with.
const statusFailures = vi.hoisted(() => new Map<string, Error>());

vi.mock("../../services/worktree-status.service", () => {
  class FakeStatusService {
    async getFullWorktreeStatus(worktreePath: string): Promise<{
      isClean: boolean;
      hasUnpushedCommits: boolean;
      hasStashedChanges: boolean;
      hasOperationInProgress: boolean;
      hasModifiedSubmodules: boolean;
      upstreamGone: boolean;
      canRemove: boolean;
      reasons: string[];
      divergence: { ahead: number; behind: number } | null;
    }> {
      statusProbes.push(worktreePath);
      const failure = statusFailures.get(worktreePath);
      if (failure) throw failure;
      return {
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        canRemove: true,
        reasons: [],
        divergence: { ahead: 3, behind: 4 },
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
  getRemoteBranchesWithActivity: ReturnType<typeof vi.fn>;
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
    updateWorktree: vi.fn<any>().mockResolvedValue({ updated: true, before: "old111", after: "new222" }),
    getDefaultBranch: vi.fn<any>().mockReturnValue("main"),
    getWorktreeMetadata: vi.fn<any>().mockResolvedValue(null),
    getRemoteBranchesWithActivity: vi.fn<any>().mockResolvedValue([]),
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
    // `=== undefined` rather than `??`: a test that passes `discovered: null` is
    // asking for the no-detected-context branch, and `??` silently handed it a
    // full context instead — which is how the fallback-throw below went untested.
    getDiscoveredContext: vi
      .fn<any>()
      .mockReturnValue(opts.discovered === undefined ? makeDiscovered() : opts.discovered),
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

  // divergence used to be a `rev-list --left-right --count HEAD...@{upstream}`
  // of its own, run beside the status probe; it is a field of the status result
  // now. Nothing else pinned the wiring, so a listing that silently stopped
  // reporting it -- or reported one thing at the top level and another under
  // `status` -- passed the whole suite. Both places are the status result's own
  // answer, and the advertised schema is parsed here rather than eyeballed
  // because `divergence` is a *required* member of the status object now.
  it("reports each worktree's divergence from its status result, at both places the schema names", async () => {
    const divergence = { ahead: 5, behind: 2 };
    const { ctx } = makeCtx({
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
          fullyPushedUpstreamDeleted: false,
          canRemove: true,
          reasons: [],
          divergence,
        }),
      },
    });

    const body = parseResponse(await invoke(handleListWorktrees, ctx, {}));

    expect(body.worktrees.map((wt: any) => wt.divergence)).toEqual([divergence, divergence]);
    expect(body.worktrees.map((wt: any) => wt.status.divergence)).toEqual([divergence, divergence]);
    expect(listWorktreesOutputSchema.parse(body).worktrees?.[0].divergence).toEqual(divergence);
  });

  // A worktree with no upstream ref to compare against says so, rather than
  // reporting the 0/0 that means "level with its upstream".
  it("passes a null divergence through as null, not as zero", async () => {
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
          fullyPushedUpstreamDeleted: false,
          canRemove: true,
          reasons: [],
          divergence: null,
        }),
      },
    });

    const body = parseResponse(await invoke(handleListWorktrees, ctx, {}));

    expect(body.worktrees[0].divergence).toBeNull();
    expect(body.worktrees[0].status.divergence).toBeNull();
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
          isCloneMode: vi.fn<any>().mockReturnValue(false),
          getWorktrees: vi
            .fn<any>()
            .mockImplementation((options?: unknown) => (gitByRepo[name].getWorktrees as any)(options)),
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
          isCloneMode: vi.fn<any>().mockReturnValue(false),
          getWorktrees: vi
            .fn<any>()
            .mockImplementation((options?: unknown) => (gitByRepo["repo-a"].getWorktrees as any)(options)),
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

// The sync planner prunes every registered worktree outside the FILTERED remote
// branch list, and a worktree created seconds ago passes every canRemove gate.
// A create that the next tick undoes is refused up front instead.
describe("handleCreateWorktree branch-filter guard", () => {
  function makeFilteredCtx(config: Record<string, unknown>, git: Partial<MockGit> = {}): ReturnType<typeof makeCtx> {
    return makeCtx({
      git: { branchExists: vi.fn<any>().mockResolvedValue({ local: false, remote: true }), ...git },
      service: { config: { worktreeDir: "/repo/worktrees", ...config } },
    });
  }

  it("refuses a branch excluded by branchInclude and never touches the worktree", async () => {
    const { ctx, git } = makeFilteredCtx({ branchInclude: ["main", "release/*"] });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "feature/x" });
    const body = parseResponse(result);

    expect(result.isError).toBe(true);
    expect(body.code).toBe("BRANCH_FILTERED");
    expect(body.message).toContain("branchInclude");
    expect(body.message).toContain('["main","release/*"]');
    expect(body.message).toContain("next sync");
    expect(body.message).toContain("force: true");
    expect(git.addWorktree).not.toHaveBeenCalled();
    expect(git.createBranch).not.toHaveBeenCalled();
  });

  it("refuses a branch excluded by branchExclude, naming that filter", async () => {
    const { ctx, git } = makeFilteredCtx({ branchExclude: ["wip-*"] });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "wip-thing" });
    const body = parseResponse(result);

    expect(body.code).toBe("BRANCH_FILTERED");
    expect(body.message).toContain("branchExclude");
    expect(body.message).not.toContain("branchInclude");
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

  it("allows a branch that passes both name filters, with no warning", async () => {
    const { ctx, git } = makeFilteredCtx({ branchInclude: ["main", "release/*"], branchExclude: ["release/old"] });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "release/1.2" });
    const body = parseResponse(result);

    expect(body.success).toBe(true);
    expect(body.warning).toBeUndefined();
    expect(git.addWorktree).toHaveBeenCalled();
  });

  // resolveSyncBranches puts the default branch back into the inventory whatever
  // the filters say, for as long as origin still has it, so refusing it here
  // would refuse a worktree sync never prunes.
  it("allows the default branch even when branchInclude excludes it", async () => {
    const { ctx, git } = makeFilteredCtx({ branchInclude: ["feature/*"] });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "main" });
    const body = parseResponse(result);

    expect(body.success).toBe(true);
    expect(body.warning).toBeUndefined();
    expect(git.addWorktree).toHaveBeenCalled();
  });

  it("still refuses a filtered default branch that origin no longer carries", async () => {
    const { ctx, git } = makeFilteredCtx(
      { branchInclude: ["feature/*"] },
      { branchExists: vi.fn<any>().mockResolvedValue({ local: true, remote: false }) },
    );

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "main" });
    const body = parseResponse(result);

    expect(body.code).toBe("BRANCH_FILTERED");
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

  it("proceeds with force:true but still reports the filter in warning", async () => {
    const { ctx, git } = makeFilteredCtx({ branchInclude: ["main"] });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "feature/x", force: true });
    const body = parseResponse(result);

    expect(result.isError).toBeUndefined();
    expect(body.success).toBe(true);
    expect(git.addWorktree).toHaveBeenCalledWith("feature/x", expect.stringContaining("feature-x"));
    expect(body.warning).toContain("branchInclude");
    expect(body.warning).toContain("next sync");
    expect(body.warning).toContain("force: true");
  });

  it("refuses a remote branch older than branchMaxAge", async () => {
    const stale = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const { ctx, git } = makeFilteredCtx(
      { branchMaxAge: "30d" },
      {
        getRemoteBranchesWithActivity: vi.fn<any>().mockResolvedValue([
          { branch: "feature/x", lastActivity: stale },
          { branch: "main", lastActivity: new Date() },
        ]),
      },
    );

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "feature/x" });
    const body = parseResponse(result);

    expect(body.code).toBe("BRANCH_FILTERED");
    expect(body.message).toContain('branchMaxAge "30d"');
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

  it("allows a remote branch inside the branchMaxAge window", async () => {
    const { ctx, git } = makeFilteredCtx(
      { branchMaxAge: "30d" },
      {
        getRemoteBranchesWithActivity: vi
          .fn<any>()
          .mockResolvedValue([{ branch: "feature/x", lastActivity: new Date() }]),
      },
    );

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "feature/x" });
    const body = parseResponse(result);

    expect(body.success).toBe(true);
    expect(body.warning).toBeUndefined();
    expect(git.addWorktree).toHaveBeenCalled();
  });

  it("does not read branch activity when branchMaxAge is unset", async () => {
    const { ctx, git } = makeFilteredCtx({ branchInclude: ["feature/*"] });

    await invoke(handleCreateWorktree, ctx, { branchName: "feature/x" });

    expect(git.getRemoteBranchesWithActivity).not.toHaveBeenCalled();
  });

  // The common case must cost nothing: with no filter configured the guard
  // returns before it reads the default branch or the remote ref store.
  it("reads no git state at all when no filter is configured", async () => {
    const { ctx, git } = makeCtx({
      git: { branchExists: vi.fn<any>().mockResolvedValue({ local: false, remote: true }) },
    });

    const body = parseResponse(await invoke(handleCreateWorktree, ctx, { branchName: "feature/x" }));

    expect(body.success).toBe(true);
    expect(git.getDefaultBranch).not.toHaveBeenCalled();
    expect(git.getRemoteBranchesWithActivity).not.toHaveBeenCalled();
  });

  // filterBranchesByName applies a list only on length > 0, so [] is "no filter"
  // in the runner. The guard reads it through the same function, and must agree.
  it("treats an empty branchInclude/branchExclude as no filter, as the runner does", async () => {
    const { ctx, git } = makeFilteredCtx({ branchInclude: [], branchExclude: [] });

    const body = parseResponse(await invoke(handleCreateWorktree, ctx, { branchName: "feature/x" }));

    expect(body.success).toBe(true);
    expect(git.addWorktree).toHaveBeenCalled();
  });

  it("does not read branch activity for a branch origin does not carry", async () => {
    const { ctx, git } = makeCtx({
      git: { branchExists: vi.fn<any>().mockResolvedValue({ local: false, remote: false }) },
      service: { config: { worktreeDir: "/repo/worktrees", branchMaxAge: "30d" } },
    });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "exp", baseBranch: "main" });
    const body = parseResponse(result);

    expect(body.success).toBe(true);
    expect(git.getRemoteBranchesWithActivity).not.toHaveBeenCalled();
  });
});

describe("handleCreateWorktree local-only branch warning", () => {
  it("warns that the next sync prunes a push:false branch", async () => {
    const { ctx } = makeCtx({
      git: { branchExists: vi.fn<any>().mockResolvedValue({ local: false, remote: false }) },
    });

    const result = await invoke(handleCreateWorktree, ctx, {
      branchName: "exp",
      baseBranch: "main",
      push: false,
    });
    const body = parseResponse(result);

    expect(body.success).toBe(true);
    expect(body.pushed).toBe(false);
    expect(body.warning).toContain("next sync");
    expect(body.warning).toContain("its branch ref");
    expect(createWorktreeOutputSchema.parse(body).warning).toBe(body.warning);
  });

  it("warns when the push failed, alongside pushError", async () => {
    const { ctx } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: false, remote: false }),
        pushBranch: vi.fn<any>().mockRejectedValue(new Error("non-fast-forward")),
      },
    });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "exp", baseBranch: "main" });
    const body = parseResponse(result);

    expect(body.success).toBe(false);
    expect(body.pushError).toBe("non-fast-forward");
    expect(body.warning).toContain("next sync");
  });

  it("warns for an existing branch that only exists locally", async () => {
    const { ctx } = makeCtx({
      git: { branchExists: vi.fn<any>().mockResolvedValue({ local: true, remote: false }) },
    });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "exp" });
    const body = parseResponse(result);

    expect(body.created).toBe(false);
    expect(body.warning).toContain("next sync");
  });

  it("does not warn once the new branch has been pushed", async () => {
    const { ctx } = makeCtx({
      git: { branchExists: vi.fn<any>().mockResolvedValue({ local: false, remote: false }) },
    });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "exp", baseBranch: "main" });
    const body = parseResponse(result);

    expect(body.pushed).toBe(true);
    expect(body.warning).toBeUndefined();
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

  function notifiedParams(notify: ReturnType<typeof vi.fn>): Array<{ progress: number; total?: number }> {
    return notify.mock.calls.map((call: unknown[]) => (call[0] as any).params);
  }

  // The one rule the protocol puts on a progress token: every notification's
  // value is above the one before it.
  function expectIncreasing(params: Array<{ progress: number; total?: number }>): void {
    for (let index = 1; index < params.length; index++) {
      expect(params[index].progress).toBeGreaterThan(params[index - 1].progress);
    }
    // A total is only ever sent when the progress fits inside it.
    for (const param of params) {
      if (param.total !== undefined) expect(param.total).toBeGreaterThanOrEqual(param.progress);
    }
  }

  // Subscribes a listener the way attachProgressReporter does and hands back a
  // function that pushes one event through it.
  function wireProgress(service: any): (event: ProgressEvent) => void {
    const listeners: Array<(event: unknown) => void> = [];
    service.onProgress = vi.fn<any>().mockImplementation((listener: any) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    });
    return (event) => {
      for (const listener of listeners) listener(event);
    };
  }

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

  // The phases carry their own item counts now; a client showing a bar wants
  // those rather than "the fifth event of this sync".
  it("reports the counts an event carries as progress and total", async () => {
    const { ctx, service } = makeCtx({});
    const emit = wireProgress(service);
    service.sync.mockImplementation(async () => {
      emit({ phase: "create", message: "Creating worktrees: 'feature-1' (1/3)", processed: 1, total: 3 });
      emit({ phase: "create", message: "Creating worktrees: 'feature-2' (2/3)", processed: 2, total: 3 });
      return { started: true };
    });

    const notify = vi.fn<any>().mockResolvedValue(undefined);
    await handleSync(ctx, {}, { mcpReq: { _meta: { progressToken: "tok-1" }, notify } } as any);

    expect(notify).toHaveBeenNthCalledWith(1, {
      method: "notifications/progress",
      params: {
        progressToken: "tok-1",
        progress: 1,
        total: 3,
        message: "[create] Creating worktrees: 'feature-1' (1/3)",
      },
    });
    expect(notify).toHaveBeenNthCalledWith(2, {
      method: "notifications/progress",
      params: {
        progressToken: "tok-1",
        progress: 2,
        total: 3,
        message: "[create] Creating worktrees: 'feature-2' (2/3)",
      },
    });
  });

  // "The progress value MUST increase with each notification, even if the total
  // is unknown" (MCP spec, notifications/progress) — while a sync's counts
  // restart at 1 in every phase and in every stage of a phase.
  it("keeps progress increasing across phases and stages that restart their counts", async () => {
    const { ctx, service } = makeCtx({});
    const emit = wireProgress(service);
    service.sync.mockImplementation(async () => {
      emit({ phase: "fetch", message: "Fetching latest data from remote" });
      emit({ phase: "create", message: "Creating worktrees for new branches" });
      for (const processed of [1, 2, 3]) {
        emit({ phase: "create", message: `Creating worktrees: 'b${processed}' (${processed}/3)`, processed, total: 3 });
      }
      emit({ phase: "prune", message: "Pruning stale worktrees" });
      for (const processed of [1, 2]) {
        emit({
          phase: "prune",
          message: `Checking worktrees to prune: 'g${processed}' (${processed}/2)`,
          processed,
          total: 2,
        });
      }
      // Same phase, second stage: the count starts over at 1.
      emit({ phase: "prune", message: "Pruning stale worktrees: 'g1' (1/1)", processed: 1, total: 1 });
      emit({ phase: "cleanup", message: "Cleanup complete" });
      return { started: true };
    });

    const notify = vi.fn<any>().mockResolvedValue(undefined);
    await handleSync(ctx, {}, { mcpReq: { _meta: { progressToken: "tok-1" }, notify } } as any);

    const params = notifiedParams(notify);
    expect(params.map((param) => param.progress)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expectIncreasing(params);
    // The counted runs keep their own denominators, offset by what came before.
    expect(params[2]).toMatchObject({ progress: 3, total: 5 });
    expect(params[8]).toMatchObject({ progress: 9, total: 9 });
  });

  // The stream git really produces: four transfer stages, each opening on
  // `0% (0/n)` and closing on a 100% line git prints twice (once plain, once
  // with ", done."). Counting those as items reported the same progress twice —
  // and made a three-branch sync of a 1200-object repository end in the
  // thousands, with the client's bar filling and resetting once per stage.
  it("keeps progress increasing across a real git transfer stream", async () => {
    const { ctx, service } = makeCtx({});
    const emit = wireProgress(service);
    // Built by the handler the git clients actually run, so the events carry
    // whatever shape it really produces.
    const transferred: ProgressEvent[] = [];
    const objects = 1200;
    const gitProgress = makeGitProgressHandler(createMockLogger, (event) => transferred.push(event));
    for (const stage of ["counting", "compressing", "receiving", "resolving"]) {
      for (const percent of [0, 25, 50, 75, 100, 100]) {
        gitProgress({
          method: "clone",
          stage,
          progress: percent,
          processed: Math.round((objects * percent) / 100),
          total: objects,
        } as SimpleGitProgressEvent);
      }
    }
    expect(transferred).toHaveLength(24);

    service.sync.mockImplementation(async () => {
      emit({ phase: "fetch", message: "Fetching latest data from remote" });
      for (const event of transferred) emit(event);
      emit({ phase: "create", message: "Creating worktrees for new branches" });
      for (const processed of [1, 2, 3]) {
        emit({ phase: "create", message: `Creating worktrees: 'b${processed}' (${processed}/3)`, processed, total: 3 });
      }
      return { started: true };
    });

    const notify = vi.fn<any>().mockResolvedValue(undefined);
    await handleSync(ctx, {}, { mcpReq: { _meta: { progressToken: "tok-1" }, notify } } as any);

    const params = notifiedParams(notify);
    expectIncreasing(params);
    // A transfer event is one tick: its percentage is already in the message,
    // and its object count is not a count of anything the sync is working
    // through. 1 fetch + 24 transfer + 1 create = 26 ticks before the items.
    expect(params.map((param) => param.progress)).toEqual(
      [...Array(26).keys()].map((index) => index + 1).concat([27, 28, 29]),
    );
    expect(params.slice(0, 26).every((param) => param.total === undefined)).toBe(true);
    expect(params.at(-1)).toMatchObject({ progress: 29, total: 29 });
  });

  // A stage that never reaches its total — an attempt that failed part way and
  // was retried — must not leave the next stage reporting a smaller total.
  it("never reports a total below the one already sent", async () => {
    const { ctx, service } = makeCtx({});
    const emit = wireProgress(service);
    service.sync.mockImplementation(async () => {
      emit({ phase: "update", message: "Checking worktrees for updates: 'a' (1/1000)", processed: 1, total: 1000 });
      emit({ phase: "update", message: "Checking worktrees for updates: 'b' (2/1000)", processed: 2, total: 1000 });
      // The attempt was abandoned there; the retry plans far fewer items.
      emit({ phase: "update", message: "Checking worktrees for updates: 'a' (1/4)", processed: 1, total: 4 });
      emit({ phase: "update", message: "Checking worktrees for updates: 'b' (2/4)", processed: 2, total: 4 });
      return { started: true };
    });

    const notify = vi.fn<any>().mockResolvedValue(undefined);
    await handleSync(ctx, {}, { mcpReq: { _meta: { progressToken: "tok-1" }, notify } } as any);

    const params = notifiedParams(notify);
    expectIncreasing(params);
    const totals = params.map((param) => param.total!);
    expect(totals).toEqual([...totals].sort((a, b) => a - b));
    expect(totals).toEqual([1000, 1000, 1000, 1000]);
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
    expect(git.updateWorktree).toHaveBeenCalledWith("/Users/foo/Repo/Feature", "feature");
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
    expect(git.updateWorktree).toHaveBeenCalledWith("/w/feature", "feature");
    expect(body.updated).toBe(true);
  });

  // A configured repository whose bare clone is not on disk yet is cloned
  // first: the listing this resolves the path against, and the fetch that
  // follows, both need it. create_worktree's identical guard is pinned by the
  // real-service suites, but every double that reaches update_worktree reports
  // isInitialized() === true — including the context-flows suite, which spies
  // the real service's isInitialized so nothing clones over the network — so
  // deleting this guard outright used to pass all of them.
  it("initializes a repository that was never cloned, before it reads the listing", async () => {
    const callOrder: string[] = [];
    const { ctx, git, service } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockImplementation(async () => {
          callOrder.push("getWorktrees");
          return [{ path: "/w/feature", branch: "feature" }];
        }),
      },
    });
    service.isInitialized.mockReturnValue(false);
    service.initializeUnlocked.mockImplementation(async () => {
      callOrder.push("initializeUnlocked");
    });

    const body = parseResponse(await invoke(handleUpdateWorktree, ctx, { path: "/w/feature" }));

    expect(body.success).toBe(true);
    expect(callOrder).toEqual(["initializeUnlocked", "getWorktrees"]);
    expect(git.updateWorktree).toHaveBeenCalledWith("/w/feature", "feature");
  });

  it("does not re-initialize a repository that is already cloned", async () => {
    const { ctx, service } = makeCtx({
      git: { getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/feature", branch: "feature" }]) },
    });

    const body = parseResponse(await invoke(handleUpdateWorktree, ctx, { path: "/w/feature" }));

    expect(body.success).toBe(true);
    expect(service.initializeUnlocked).not.toHaveBeenCalled();
  });

  // The discovery snapshot has no freshness check: a `git checkout -b` inside
  // a worktree touches only that worktree's own admin HEAD, so the branch the
  // session recorded at detection time can outlive the checkout it described.
  // Acting on that name would merge origin/<old branch> into the worktree and,
  // whenever the new branch has no commits of its own, fast-forward *it* to the
  // old branch's tip — a silent branch rewrite. The branch is read back from
  // git before the fetch and the merge.
  it("merges the branch the worktree is on now, not the one the discovery snapshot remembers", async () => {
    const { ctx, git, service } = makeCtx({
      discovered: makeDiscovered({ allWorktrees: [{ path: "/w/main", branch: "main", isCurrent: false }] }),
      git: { getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/main", branch: "wip" }]) },
    });

    const result = await invoke(handleUpdateWorktree, ctx, { path: "/w/main" });

    expect(parseResponse(result).success).toBe(true);
    expect(service.getWorktrees).toHaveBeenCalled();
    expect(git.updateWorktree).toHaveBeenCalledWith("/w/main", "wip");
    expect(git.updateWorktree).not.toHaveBeenCalledWith("/w/main", "main");
    expect(git.fetchBranch).toHaveBeenCalledWith("wip");
    expect(git.fetchBranch).not.toHaveBeenCalledWith("main");
  });

  it("reports updated:false when the worktree already matched origin/<branch>", async () => {
    const { ctx, git } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/feature", branch: "feature" }]),
        updateWorktree: vi.fn<any>().mockResolvedValue({ updated: false, before: "abc123", after: "abc123" }),
      },
    });
    const result = await invoke(handleUpdateWorktree, ctx, { path: "/w/feature" });
    const body = parseResponse(result);
    expect(body).toEqual({ success: true, worktreePath: "/w/feature", updated: false });
    expect(git.updateWorktree).toHaveBeenCalledWith("/w/feature", "feature");
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
          return { updated: true, before: "old111", after: "new222" };
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

  // A detached worktree has no branch for a fast-forward to move, and git's
  // listing says so with a `detached` flag and no branch name. `branch` is the
  // empty string on such a row, so anything that got past this guard would
  // fetch and merge `origin/` — a name git reads as a refspec of its own.
  it("refuses a detached worktree by name, and neither fetches nor merges", async () => {
    const { ctx, git } = makeCtx({
      git: {
        getWorktrees: vi
          .fn<any>()
          .mockResolvedValue([{ path: "/w/feature", branch: "", detached: true, head: "9f1c0de" }]),
      },
    });

    const result = await invoke(handleUpdateWorktree, ctx, { path: "/w/feature" });
    const body = parseResponse(result);

    expect(body.code).toBe("DETACHED_HEAD");
    expect(body.message).toContain("detached HEAD");
    expect(body.message).toContain("9f1c0de");
    expect(body.message).toContain("/w/feature");
    // The symptom being replaced: a path git has registered, reported as one
    // this repository does not have.
    expect(body.message).not.toContain("not a registered worktree");
    expect(git.fetchBranch).not.toHaveBeenCalled();
    expect(git.updateWorktree).not.toHaveBeenCalled();
  });

  // The guard can only fire on an entry the listing returned, and git omits
  // detached worktrees unless asked for them — so the membership listing has
  // to ask. Without this the refusal above is unreachable against real git and
  // the old "not a registered worktree" answer comes back.
  it("asks the membership listing for detached entries", async () => {
    const { ctx, service } = makeCtx({
      git: { getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/feature", branch: "feature" }]) },
    });

    expect(parseResponse(await invoke(handleUpdateWorktree, ctx, { path: "/w/feature" })).success).toBe(true);
    expect(service.getWorktrees).toHaveBeenCalledWith(expect.objectContaining({ includeDetached: true }));
  });

  // `detached` is set only when true, so "absent" is the ordinary case and must
  // not read as detached.
  it("fast-forwards a worktree whose listing row carries no detached flag", async () => {
    const { ctx, git } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/feature", branch: "feature", head: "9f1c0de" }]),
      },
    });

    const body = parseResponse(await invoke(handleUpdateWorktree, ctx, { path: "/w/feature" }));

    expect(body.success).toBe(true);
    expect(git.fetchBranch).toHaveBeenCalledWith("feature");
    expect(git.updateWorktree).toHaveBeenCalledWith("/w/feature", "feature");
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

  // get_worktree_status stopped computing divergence of its own: it rides in on
  // the `...status` spread. The advertised schema still requires the field, so
  // parse the body rather than only reading it.
  it("reports divergence from the status result", async () => {
    const divergence = { ahead: 1, behind: 7 };
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
          fullyPushedUpstreamDeleted: false,
          canRemove: true,
          reasons: [],
          divergence,
        }),
      },
    });

    const body = parseResponse(await invoke(handleGetWorktreeStatus, ctx, { path: "/w/x" }));

    expect(body.divergence).toEqual(divergence);
    expect(getWorktreeStatusOutputSchema.parse(body).divergence).toEqual(divergence);
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

  // The consequence of the choice below, pinned so it stays a decision rather
  // than a surprise: membership for a DETACHED path still depends on cache
  // state here. The discovery snapshot lists such a worktree (under the
  // pseudo-name `(detached <sha>)`), the fresh branch-only listing does not —
  // so a warm snapshot answers and a cold one says "not a registered worktree"
  // about the same registered path. Harmless only because this handler throws
  // `.branch` away; `update_worktree`, which does not, resolves `fresh` plus
  // `includeDetached` and is cache-independent either way.
  it("answers a detached path from the snapshot but denies it without one", async () => {
    const detachedPath = "/w/loose";
    const gitMock = {
      getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/x", branch: "x" }]),
      getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({ isClean: false, reasons: ["detached HEAD"] }),
    };

    const warm = makeCtx({
      discovered: makeDiscovered({ allWorktrees: [{ path: detachedPath, branch: "(detached 9f1c0de)" } as any] }),
      git: gitMock,
    });
    const warmBody = parseResponse(await invoke(handleGetWorktreeStatus, warm.ctx, { path: detachedPath }));
    expect(warmBody.path).toBe(detachedPath);
    expect(warmBody.reasons).toContain("detached HEAD");

    const cold = makeCtx({ discovered: makeDiscovered({ allWorktrees: [] }), git: gitMock });
    const coldBody = parseResponse(await invoke(handleGetWorktreeStatus, cold.ctx, { path: detachedPath }));
    expect(coldBody.message).toContain("not a registered worktree");
  });

  // Read-only tools are left alone: they already describe a detached worktree
  // (`get_worktree_status` puts "detached HEAD" in its reasons), so widening
  // their listing would only change which paths they accept. Only the tool
  // that acts on `branch` asks for detached entries.
  it("keeps asking for the branch-only listing", async () => {
    const { ctx, service } = makeCtx({
      discovered: makeDiscovered({ allWorktrees: [] }),
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/w/x", branch: "x" }]),
        getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({ isClean: true, reasons: [] }),
      },
    });

    await invoke(handleGetWorktreeStatus, ctx, { path: "/w/x" });

    expect(service.getWorktrees).toHaveBeenCalledWith(expect.objectContaining({ includeDetached: false }));
  });
});

describe("handleLoadConfig", () => {
  it("returns error when no configPath or discoverable config exists", async () => {
    const { ctx } = makeCtx({});
    const result = await invoke(handleLoadConfig, ctx, {});
    const body = parseResponse(result);
    expect(body.error).toBe(true);
    expect(body.message).toContain("detect_context");
  });

  it("reuses an already detected config path", async () => {
    const { ctx } = makeCtx({ configPath: "/workspace/sync-worktrees.config.js" });
    const result = await invoke(handleLoadConfig, ctx, {});
    const body = parseResponse(result);

    expect(body.error).toBeUndefined();
    expect(ctx.loadConfig).toHaveBeenCalledWith("/workspace/sync-worktrees.config.js");
    expect(ctx.detectFromPath).not.toHaveBeenCalled();
  });

  it("auto-detects config from launch CWD when no config is already known", async () => {
    const { ctx } = makeCtx({
      discovered: makeDiscovered({ configPath: "/workspace/sync-worktrees.config.js" }),
      launchCwd: "/workspace/repo/main",
    });
    const result = await invoke(handleLoadConfig, ctx, {});
    const body = parseResponse(result);

    expect(body.error).toBeUndefined();
    expect(ctx.detectFromPath).toHaveBeenCalledWith("/workspace/repo/main");
    expect(ctx.loadConfig).toHaveBeenCalledWith("/workspace/sync-worktrees.config.js");
  });

  it("surfaces the real parse error when detection finds a config that fails to load", async () => {
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

  // A configured repository that has never been cloned: `git worktree list` runs
  // against a bare directory that is not there, and nothing was detected on disk
  // to fall back to. The old message ("service not initialized and no detected
  // context") named the two things that failed and neither the cause nor the fix.
  it("names the underlying git failure and points at initialize when there is no fallback", async () => {
    const { ctx } = makeCtx({
      discovered: null,
      currentRepo: "backend",
      git: {
        getWorktrees: vi
          .fn<any>()
          .mockRejectedValue(new Error("Cannot use simple-git on a directory that does not exist")),
      },
    });

    const result = await invoke(handleListWorktrees, ctx, {});
    const body = parseResponse(result);

    expect(result.isError).toBe(true);
    expect(body.message).toContain("Cannot use simple-git on a directory that does not exist");
    expect(body.message).toContain("initialize");
    expect(body.message).toContain("backend");
    expect(body.message).not.toContain("service not initialized and no detected context");
  });

  it("names the repository from repoName when one was passed", async () => {
    const { ctx } = makeCtx({
      discovered: null,
      currentRepo: "backend",
      configuredRepoNames: [],
      git: { getWorktrees: vi.fn<any>().mockRejectedValue(new Error("boom")) },
    });

    const body = parseResponse(await invoke(handleListWorktrees, ctx, { repoName: "frontend" }));
    expect(body.message).toContain("'frontend'");
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

// A retry after a client timeout must be distinguishable from the first call.
// Before `worktreeExisted`, the second create_worktree for the same branch
// answered {success:true, created:false, pushed:false, worktreePath} — byte for
// byte what "checked an existing remote branch out into a brand new worktree"
// answers — so an agent could not tell a no-op from a fresh checkout.
describe("handleCreateWorktree worktreeExisted", () => {
  const targetPath = new PathResolutionService().getBranchWorktreePath("/repo/worktrees", "feature/x");

  function makeCreateCtx(
    worktrees: Array<{ path: string; branch: string }>,
    existence = { local: true, remote: true },
  ): ReturnType<typeof makeCtx> {
    return makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue(existence),
        getWorktrees: vi.fn<any>().mockResolvedValue(worktrees),
      },
    });
  }

  it("reports worktreeExisted=true, created=false when the path is already registered for the branch", async () => {
    const { ctx, git } = makeCreateCtx([{ path: targetPath, branch: "feature/x" }]);

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "feature/x" });
    const body = parseResponse(result);

    expect(body.success).toBe(true);
    expect(body.worktreeExisted).toBe(true);
    expect(body.created).toBe(false);
    expect(createWorktreeOutputSchema.parse(body).worktreeExisted).toBe(true);
    // A no-op create still must not push or branch behind the caller's back.
    expect(git.createBranch).not.toHaveBeenCalled();
    expect(git.pushBranch).not.toHaveBeenCalled();
  });

  it("reports worktreeExisted=false for a fresh path, even with other worktrees registered", async () => {
    const { ctx } = makeCreateCtx([{ path: "/repo/worktrees/main", branch: "main" }]);

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "feature/x" });
    const body = parseResponse(result);

    expect(body.success).toBe(true);
    expect(body.worktreeExisted).toBe(false);
    expect(body.created).toBe(false);
    expect(createWorktreeOutputSchema.parse(body).worktreeExisted).toBe(false);
  });

  // `created` and `worktreeExisted` answer different questions: a brand new
  // branch is `created: true` with nothing at the path, so neither field alone
  // tells the agent what it is holding.
  it("reports worktreeExisted=false when the branch itself was created", async () => {
    const { ctx } = makeCreateCtx([], { local: false, remote: false });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "feature/x", baseBranch: "main" });
    const body = parseResponse(result);

    expect(body.created).toBe(true);
    expect(body.worktreeExisted).toBe(false);
  });

  // The schema requires the field, so the partial-success return must carry it
  // too or the SDK turns the whole result into an error.
  it("carries worktreeExisted on the push-failure result", async () => {
    const { ctx } = makeCtx({
      git: {
        branchExists: vi.fn<any>().mockResolvedValue({ local: false, remote: false }),
        pushBranch: vi.fn<any>().mockRejectedValue(new Error("non-fast-forward")),
      },
    });

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "exp", baseBranch: "main" });
    const body = parseResponse(result);

    expect(body.success).toBe(false);
    expect(body.worktreeExisted).toBe(false);
    expect(createWorktreeOutputSchema.parse(body).worktreeExisted).toBe(false);
  });

  it("matches the registration by path, not by position in the listing", async () => {
    const { ctx } = makeCreateCtx([
      { path: "/repo/worktrees/main", branch: "main" },
      { path: targetPath, branch: "feature/x" },
    ]);

    const body = parseResponse(await invoke(handleCreateWorktree, ctx, { branchName: "feature/x" }));

    expect(body.worktreeExisted).toBe(true);
  });

  // A registration for a *different* branch at the same sanitized path is the
  // collision error, not a worktreeExisted:true success.
  it("still errors on a path collision rather than reporting worktreeExisted", async () => {
    const { ctx } = makeCreateCtx([{ path: targetPath, branch: "feature-x" }]);

    const result = await invoke(handleCreateWorktree, ctx, { branchName: "feature/x" });
    const body = parseResponse(result);

    expect(result.isError).toBe(true);
    expect(body.worktreeExisted).toBeUndefined();
    expect(body.message).toContain("collides");
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

  it("names why the status probe failed instead of a bare 'status unavailable', without credentials", async () => {
    const { ctx } = makeCtx({
      git: {
        getWorktrees: vi.fn<any>().mockResolvedValue([{ path: "/repo/feat", branch: "feat" }]),
        getFullWorktreeStatus: vi
          .fn<any>()
          .mockRejectedValue(new Error("fatal: unable to access 'https://user:s3cret-token@github.com/org/repo.git/'")),
      },
    });

    const result = await invoke(handleListWorktrees, ctx, {});
    const body = parseResponse(result);

    expect(body.worktrees[0].status).toBeNull();
    expect(body.worktrees[0].label).toBe("unknown");
    expect(body.worktrees[0].safeToRemove.safe).toBe(false);
    expect(body.worktrees[0].safeToRemove.reason).toMatch(/^status unavailable: fatal: unable to access/);
    expect(JSON.stringify(result)).not.toContain("s3cret-token");
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
    // Straight off the status result, not a second rev-list of its own.
    expect(body.allWorktrees[1].divergence).toEqual({ ahead: 3, behind: 4 });
  });

  it("reports why a worktree's status probe failed next to its 'unknown' label", async () => {
    statusFailures.set(
      "/repo/broken",
      new Error("fatal: unable to access 'https://user:s3cret-token@github.com/org/repo.git/'"),
    );
    try {
      const ctx = {
        detectFromPath: vi.fn<any>().mockResolvedValue(
          makeDiscovered({
            allWorktrees: [
              { path: "/repo/main", branch: "main", isCurrent: true },
              { path: "/repo/broken", branch: "broken", isCurrent: false },
            ],
          }),
        ),
        getConfiguredRepositorySummaries: vi.fn<any>().mockResolvedValue([]),
      } as unknown as RepositoryContext;

      const result = await invoke(handleDetectContext, ctx, { includeStatus: true });
      const body = parseResponse(result);

      expect(body.allWorktrees[0].statusError).toBeUndefined();
      expect(body.allWorktrees[1].label).toBe("unknown");
      expect(body.allWorktrees[1].statusError).toMatch(/^fatal: unable to access/);
      expect(JSON.stringify(result)).not.toContain("s3cret-token");
    } finally {
      statusFailures.clear();
    }
  });

  // allWorktrees and allWorktreesByRepo[<current repo>] are two separate
  // `worktree list --porcelain` reads of the same repository, so every worktree
  // of the current repo is in both. Enriching each list independently probed
  // all of them twice -- 8 git processes per worktree, spent twice.
  it("probes each worktree once when both lists name it", async () => {
    statusProbes.length = 0;
    const listed = [
      { path: "/repo/main", branch: "main", isCurrent: true },
      { path: "/repo/feat", branch: "feat", isCurrent: false },
    ];
    const ctx = {
      detectFromPath: vi.fn<any>().mockResolvedValue(makeDiscovered({ allWorktrees: listed })),
      getConfiguredRepositorySummaries: vi.fn<any>().mockResolvedValue([]),
      getAllConfiguredWorktreeDetails: vi.fn<any>().mockResolvedValue({
        // Distinct objects carrying the same paths, exactly as the two reads
        // produce them.
        worktreesByRepo: { test: listed.map((wt) => ({ ...wt })) },
        errorsByRepo: {},
      }),
    } as unknown as RepositoryContext;

    const result = await invoke(handleDetectContext, ctx, { includeStatus: true, includeAllWorktrees: true });
    const body = parseResponse(result);

    expect([...statusProbes].sort()).toEqual(["/repo/feat", "/repo/main"]);
    // Both lists still report the enrichment, and report the same thing.
    expect(body.allWorktrees.map((wt: any) => [wt.label, wt.divergence])).toEqual([
      ["current", { ahead: 3, behind: 4 }],
      ["clean", { ahead: 3, behind: 4 }],
    ]);
    expect(body.allWorktreesByRepo.test).toEqual(body.allWorktrees);
  });

  it("still probes a path that two lists disagree about", async () => {
    statusProbes.length = 0;
    const ctx = {
      detectFromPath: vi
        .fn<any>()
        .mockResolvedValue(makeDiscovered({ allWorktrees: [{ path: "/repo/main", branch: "main", isCurrent: true }] })),
      getConfiguredRepositorySummaries: vi.fn<any>().mockResolvedValue([]),
      getAllConfiguredWorktreeDetails: vi.fn<any>().mockResolvedValue({
        worktreesByRepo: { test: [{ path: "/repo/main", branch: "main", isCurrent: false }] },
        errorsByRepo: {},
      }),
    } as unknown as RepositoryContext;

    const result = await invoke(handleDetectContext, ctx, { includeStatus: true, includeAllWorktrees: true });
    const body = parseResponse(result);

    expect(statusProbes).toEqual(["/repo/main", "/repo/main"]);
    expect(body.allWorktrees[0].label).toBe("current");
    expect(body.allWorktreesByRepo.test[0].label).toBe("clean");
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
