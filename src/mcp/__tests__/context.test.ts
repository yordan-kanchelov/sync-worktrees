import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RepositoryContext } from "../context";

const mockRemoteUrl = vi.fn<any>();
const mockWorktreeList = vi.fn<any>();

vi.mock("simple-git", () => {
  return {
    default: vi.fn(() => ({
      remote: mockRemoteUrl,
      raw: mockWorktreeList,
    })),
  };
});

vi.mock("../../services/worktree-sync.service", () => {
  return {
    WorktreeSyncService: vi.fn().mockImplementation((config) => ({
      config,
      initialize: vi.fn(),
      isInitialized: () => false,
      isSyncInProgress: () => false,
      getGitService: vi.fn(),
    })),
  };
});

async function makeWorktreeFixture(): Promise<{
  root: string;
  bareRepo: string;
  worktreesDir: string;
  currentWorktree: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-ctx-"));
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

describe("RepositoryContext.detectFromPath", () => {
  let fixture: Awaited<ReturnType<typeof makeWorktreeFixture>>;

  beforeEach(async () => {
    fixture = await makeWorktreeFixture();
    mockRemoteUrl.mockReset();
    mockWorktreeList.mockReset();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("detects a worktree and builds DiscoveredRepoContext", async () => {
    mockRemoteUrl.mockResolvedValue("https://github.com/test/repo.git\n");
    mockWorktreeList.mockResolvedValue(
      [
        `worktree ${fixture.currentWorktree}`,
        "branch refs/heads/feature-x",
        "",
        `worktree ${path.join(fixture.worktreesDir, "main")}`,
        "branch refs/heads/main",
        "",
      ].join("\n"),
    );

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(fixture.currentWorktree);

    expect(result.isWorktree).toBe(true);
    expect(result.kind).toBe("unmanaged");
    expect(result.bareRepoPath).toBe(path.resolve(fixture.bareRepo));
    expect(result.repoUrl).toBe("https://github.com/test/repo.git");
    expect(result.currentBranch).toBe("feature-x");
    expect(result.allWorktrees).toHaveLength(2);
    expect(result.capabilities.canListWorktrees).toBe(true);
    expect(result.capabilities.canCreateWorktree).toBe(true);
    expect(result.capabilities.canSync).toBe(false);
    expect(result.capabilities.canInitialize).toBe(false);
  });

  it("returns unsupported for regular git repo (directory .git)", async () => {
    const regularRepo = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-regular-"));
    await fs.mkdir(path.join(regularRepo, ".git"), { recursive: true });

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(regularRepo);

    expect(result.isWorktree).toBe(false);
    expect(result.kind).toBe("unsupported");
    expect(result.capabilities.canListWorktrees).toBe(false);
    expect(result.reasons.some((r) => r.includes("regular repo"))).toBe(true);

    await fs.rm(regularRepo, { recursive: true, force: true });
  });

  it("returns unsupported for non-git directory", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-plain-"));

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(plain);

    expect(result.isWorktree).toBe(false);
    expect(result.kind).toBe("unsupported");

    await fs.rm(plain, { recursive: true, force: true });
  });

  it("marks detected repo as managed when config matches bareRepoPath", async () => {
    mockRemoteUrl.mockResolvedValue("https://github.com/test/repo.git\n");
    mockWorktreeList.mockResolvedValue(
      [`worktree ${fixture.currentWorktree}`, "branch refs/heads/feature-x", ""].join("\n"),
    );

    const ctx = new RepositoryContext();
    (ctx as any).repos.set("configured", {
      name: "configured",
      config: {
        repoUrl: "https://github.com/test/repo.git",
        bareRepoDir: path.resolve(fixture.bareRepo),
        worktreeDir: fixture.worktreesDir,
        cronSchedule: "0 * * * *",
        runOnce: true,
      },
      source: "config" as const,
    });

    const result = await ctx.detectFromPath(fixture.currentWorktree);
    expect(result.kind).toBe("managed");
    expect(result.repoName).toBe("configured");
    expect(result.capabilities.canSync).toBe(true);
    expect(result.capabilities.canInitialize).toBe(true);
  });

  it("includes helpful reason when no remote URL detected", async () => {
    mockRemoteUrl.mockRejectedValue(new Error("no remote"));
    mockWorktreeList.mockResolvedValue(
      [`worktree ${fixture.currentWorktree}`, "branch refs/heads/feature-x", ""].join("\n"),
    );

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(fixture.currentWorktree);

    expect(result.repoUrl).toBeNull();
    expect(result.capabilities.canCreateWorktree).toBe(false);
    expect(result.reasons.some((r) => r.includes("create_worktree"))).toBe(true);
  });
});

describe("RepositoryContext.detectFromPath caching", () => {
  let fixture: Awaited<ReturnType<typeof makeWorktreeFixture>>;

  beforeEach(async () => {
    fixture = await makeWorktreeFixture();
    mockRemoteUrl.mockReset();
    mockWorktreeList.mockReset();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("returns cached result on second call within TTL without re-running git", async () => {
    mockRemoteUrl.mockResolvedValue("https://github.com/test/repo.git\n");
    mockWorktreeList.mockResolvedValue(
      [`worktree ${fixture.currentWorktree}`, "branch refs/heads/feature-x", ""].join("\n"),
    );

    const ctx = new RepositoryContext();
    await ctx.detectFromPath(fixture.currentWorktree);
    const firstCallCount = mockWorktreeList.mock.calls.length;

    await ctx.detectFromPath(fixture.currentWorktree);
    expect(mockWorktreeList.mock.calls.length).toBe(firstCallCount);
  });

  it("re-detects after invalidateDiscovered()", async () => {
    mockRemoteUrl.mockResolvedValue("https://github.com/test/repo.git\n");
    mockWorktreeList.mockResolvedValue(
      [`worktree ${fixture.currentWorktree}`, "branch refs/heads/feature-x", ""].join("\n"),
    );

    const ctx = new RepositoryContext();
    await ctx.detectFromPath(fixture.currentWorktree);
    const firstCallCount = mockWorktreeList.mock.calls.length;

    ctx.invalidateDiscovered();
    await ctx.detectFromPath(fixture.currentWorktree);
    expect(mockWorktreeList.mock.calls.length).toBe(firstCallCount + 1);
  });

  it("re-detects when worktree HEAD mtime changes", async () => {
    mockRemoteUrl.mockResolvedValue("https://github.com/test/repo.git\n");
    mockWorktreeList.mockResolvedValue(
      [`worktree ${fixture.currentWorktree}`, "branch refs/heads/feature-x", ""].join("\n"),
    );

    const adminDir = path.join(fixture.bareRepo, "worktrees", "feature-x");
    const headPath = path.join(adminDir, "HEAD");
    await fs.writeFile(headPath, "ref: refs/heads/feature-x\n", "utf-8");

    const ctx = new RepositoryContext();
    await ctx.detectFromPath(fixture.currentWorktree);
    const firstCallCount = mockWorktreeList.mock.calls.length;

    const future = new Date(Date.now() + 10_000);
    await fs.utimes(headPath, future, future);

    await ctx.detectFromPath(fixture.currentWorktree);
    expect(mockWorktreeList.mock.calls.length).toBe(firstCallCount + 1);
  });

  it("does not cache unsupported results", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-plain-cache-"));

    const ctx = new RepositoryContext();
    await ctx.detectFromPath(plain);
    await ctx.detectFromPath(plain);

    expect((ctx as any).discoveryCache.size).toBe(0);

    await fs.rm(plain, { recursive: true, force: true });
  });
});

describe("RepositoryContext.getService", () => {
  it("throws when no repo specified and none registered", async () => {
    const ctx = new RepositoryContext();
    await expect(ctx.getService()).rejects.toThrow(/No repository/);
  });

  it("throws when named repo not found", async () => {
    const ctx = new RepositoryContext();
    await expect(ctx.getService("missing")).rejects.toThrow(/not found/);
  });
});

describe("RepositoryContext.detectFromPath currentRepo bootstrap invariants", () => {
  let fixture: Awaited<ReturnType<typeof makeWorktreeFixture>>;

  beforeEach(async () => {
    fixture = await makeWorktreeFixture();
    mockRemoteUrl.mockReset();
    mockWorktreeList.mockReset();
    mockRemoteUrl.mockResolvedValue("https://github.com/test/repo.git\n");
    mockWorktreeList.mockResolvedValue(
      [`worktree ${fixture.currentWorktree}`, "branch refs/heads/feature-x", ""].join("\n"),
    );
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("bootstraps currentRepo when null and single entry results", async () => {
    const ctx = new RepositoryContext();
    expect(ctx.getCurrentRepo()).toBeNull();

    await ctx.detectFromPath(fixture.currentWorktree);
    expect(ctx.getCurrentRepo()).not.toBeNull();
  });

  it("does not overwrite existing currentRepo when probing new path", async () => {
    const ctx = new RepositoryContext();
    (ctx as any).repos.set("pinned", {
      name: "pinned",
      config: {
        repoUrl: "https://example.com/other.git",
        bareRepoDir: "/some/other/.bare",
        worktreeDir: "/some/other/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: true,
      },
      source: "config" as const,
    });
    (ctx as any).currentRepo = "pinned";

    await ctx.detectFromPath(fixture.currentWorktree);
    expect(ctx.getCurrentRepo()).toBe("pinned");
  });

  it("does not auto-select when multiple repo entries exist and currentRepo is null", async () => {
    const ctx = new RepositoryContext();
    (ctx as any).repos.set("other", {
      name: "other",
      config: {
        repoUrl: "https://example.com/other.git",
        bareRepoDir: "/some/other/.bare",
        worktreeDir: "/some/other/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: true,
      },
      source: "config" as const,
    });

    await ctx.detectFromPath(fixture.currentWorktree);
    expect(ctx.getCurrentRepo()).toBeNull();
  });

  it("reuses existing detected entry on repeat probes (no duplicate)", async () => {
    const ctx = new RepositoryContext();
    await ctx.detectFromPath(fixture.currentWorktree);
    const sizeAfterFirst = (ctx as any).repos.size;
    ctx.invalidateDiscovered();
    await ctx.detectFromPath(fixture.currentWorktree);
    expect((ctx as any).repos.size).toBe(sizeAfterFirst);
  });
});
