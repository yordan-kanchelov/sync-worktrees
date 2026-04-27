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
    expect(result.capabilities.listWorktrees.available).toBe(true);
    expect(result.capabilities.createWorktree.available).toBe(true);
    expect(result.capabilities.sync.available).toBe(false);
    expect(result.capabilities.initialize.available).toBe(false);
  });

  it("returns unsupported for regular git repo (directory .git)", async () => {
    const regularRepo = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-regular-"));
    await fs.mkdir(path.join(regularRepo, ".git"), { recursive: true });

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(regularRepo);

    expect(result.isWorktree).toBe(false);
    expect(result.kind).toBe("unsupported");
    expect(result.capabilities.listWorktrees.available).toBe(false);
    expect(result.notes.some((r: string) => r.includes("regular repo"))).toBe(true);

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
    ctx.__registerForTest("configured", {
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
    expect(result.capabilities.sync.available).toBe(true);
    expect(result.capabilities.initialize.available).toBe(true);
  });

  it("resolves relative gitdir path against the worktree root", async () => {
    mockRemoteUrl.mockResolvedValue("https://github.com/test/repo.git\n");
    mockWorktreeList.mockResolvedValue(
      [`worktree ${fixture.currentWorktree}`, "branch refs/heads/feature-x", ""].join("\n"),
    );

    const relativeGitdir = path.relative(
      fixture.currentWorktree,
      path.join(fixture.bareRepo, "worktrees", "feature-x"),
    );
    await fs.writeFile(path.join(fixture.currentWorktree, ".git"), `gitdir: ${relativeGitdir}\n`, "utf-8");

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(fixture.currentWorktree);

    expect(result.isWorktree).toBe(true);
    expect(result.bareRepoPath).toBe(path.resolve(fixture.bareRepo));
    expect(result.currentBranch).toBe("feature-x");
  });

  it("includes helpful reason when no remote URL detected", async () => {
    mockRemoteUrl.mockRejectedValue(new Error("no remote"));
    mockWorktreeList.mockResolvedValue(
      [`worktree ${fixture.currentWorktree}`, "branch refs/heads/feature-x", ""].join("\n"),
    );

    const ctx = new RepositoryContext();
    const result = await ctx.detectFromPath(fixture.currentWorktree);

    expect(result.repoUrl).toBeNull();
    expect(result.capabilities.createWorktree.available).toBe(false);
    expect(result.capabilities.createWorktree.reason).toContain("remote origin URL");
  });
});

describe("RepositoryContext.detectFromPath sibling discovery", () => {
  it("discovers sibling repos with .bare directories under workspace root", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-siblings-"));
    try {
      const currentRepo = path.join(workspace, "repo-current");
      const currentBare = path.join(currentRepo, ".bare");
      const adminDir = path.join(currentBare, "worktrees", "main");
      await fs.mkdir(adminDir, { recursive: true });
      const currentWt = path.join(currentRepo, "worktrees", "main");
      await fs.mkdir(currentWt, { recursive: true });
      await fs.writeFile(path.join(currentWt, ".git"), `gitdir: ${adminDir}\n`, "utf-8");

      await fs.mkdir(path.join(workspace, "repo-sibling-a", ".bare"), { recursive: true });
      await fs.mkdir(path.join(workspace, "repo-sibling-b", ".bare"), { recursive: true });
      await fs.mkdir(path.join(workspace, "not-a-repo"), { recursive: true });

      mockRemoteUrl.mockResolvedValue("https://github.com/test/repo.git\n");
      mockWorktreeList.mockResolvedValue([`worktree ${currentWt}`, "branch refs/heads/main", ""].join("\n"));

      const ctx = new RepositoryContext();
      const result = await ctx.detectFromPath(currentWt);

      expect(result.siblingRepositories.length).toBe(3);
      const names = result.siblingRepositories.map((s) => s.name).sort();
      expect(names).toEqual(["repo-current", "repo-sibling-a", "repo-sibling-b"]);
      for (const sib of result.siblingRepositories) {
        expect(sib.bareRepoPath).toMatch(/\.bare$/);
        expect(sib.configMatched).toBe(false);
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("marks sibling as configMatched when bareRepoDir matches a loaded config repo", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-siblings-cfg-"));
    try {
      const currentRepo = path.join(workspace, "repo-current");
      const currentBare = path.join(currentRepo, ".bare");
      const adminDir = path.join(currentBare, "worktrees", "main");
      await fs.mkdir(adminDir, { recursive: true });
      const currentWt = path.join(currentRepo, "worktrees", "main");
      await fs.mkdir(currentWt, { recursive: true });
      await fs.writeFile(path.join(currentWt, ".git"), `gitdir: ${adminDir}\n`, "utf-8");

      const siblingA = path.join(workspace, "repo-sibling-a");
      await fs.mkdir(path.join(siblingA, ".bare"), { recursive: true });

      mockRemoteUrl.mockResolvedValue("https://github.com/test/repo.git\n");
      mockWorktreeList.mockResolvedValue([`worktree ${currentWt}`, "branch refs/heads/main", ""].join("\n"));

      const ctx = new RepositoryContext();
      ctx.__registerForTest("named-sibling", {
        config: {
          repoUrl: "https://github.com/test/sibling.git",
          bareRepoDir: path.join(siblingA, ".bare"),
          worktreeDir: path.join(siblingA, "worktrees"),
          cronSchedule: "0 * * * *",
          runOnce: true,
        },
        source: "config" as const,
      });

      const result = await ctx.detectFromPath(currentWt);
      const matched = result.siblingRepositories.find((s) => s.configMatched);
      expect(matched).toBeDefined();
      expect(matched?.name).toBe("named-sibling");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("RepositoryContext.detectFromPath config auto-discovery", () => {
  it("auto-loads sync-worktrees.config.js found by walking up", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auto-cfg-"));
    try {
      const currentRepo = path.join(workspace, "repo-current");
      const currentBare = path.join(currentRepo, ".bare");
      const adminDir = path.join(currentBare, "worktrees", "main");
      await fs.mkdir(adminDir, { recursive: true });
      const currentWt = path.join(currentRepo, "worktrees", "main");
      await fs.mkdir(currentWt, { recursive: true });
      await fs.writeFile(path.join(currentWt, ".git"), `gitdir: ${adminDir}\n`, "utf-8");

      const configPath = path.join(workspace, "sync-worktrees.config.js");
      const cfgBody = `export default { repositories: [{ name: "auto-loaded", repoUrl: "https://github.com/test/repo.git", bareRepoDir: ${JSON.stringify(currentBare)}, worktreeDir: ${JSON.stringify(path.join(currentRepo, "worktrees"))}, cronSchedule: "0 * * * *", runOnce: true }] };`;
      await fs.writeFile(configPath, cfgBody, "utf-8");

      mockRemoteUrl.mockResolvedValue("https://github.com/test/repo.git\n");
      mockWorktreeList.mockResolvedValue([`worktree ${currentWt}`, "branch refs/heads/main", ""].join("\n"));

      const ctx = new RepositoryContext();
      const result = await ctx.detectFromPath(currentWt);

      expect(result.configPath).toBe(configPath);
      expect(result.kind).toBe("managed");
      expect(result.repoName).toBe("auto-loaded");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
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
    const beforeMtimeMs = (await fs.stat(headPath)).mtimeMs;

    const future = new Date(Date.now() + 10_000);
    await fs.utimes(headPath, future, future);
    const afterMtimeMs = (await fs.stat(headPath)).mtimeMs;
    // Guard against coarse-resolution filesystems: the test premise requires
    // the utimes call to actually change mtime observed by fs.stat.
    expect(afterMtimeMs).toBeGreaterThan(beforeMtimeMs);

    await ctx.detectFromPath(fixture.currentWorktree);
    expect(mockWorktreeList.mock.calls.length).toBe(firstCallCount + 1);
  });

  it("does not cache unsupported results", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-plain-cache-"));

    const ctx = new RepositoryContext();
    await ctx.detectFromPath(plain);
    await ctx.detectFromPath(plain);

    expect(ctx.__discoveryCacheSizeForTest()).toBe(0);

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
    ctx.__registerForTest("pinned", {
      config: {
        repoUrl: "https://example.com/other.git",
        bareRepoDir: "/some/other/.bare",
        worktreeDir: "/some/other/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: true,
      },
      source: "config" as const,
    });
    ctx.__setCurrentRepoForTest("pinned");

    await ctx.detectFromPath(fixture.currentWorktree);
    expect(ctx.getCurrentRepo()).toBe("pinned");
  });

  it("does not auto-select when multiple repo entries exist and currentRepo is null", async () => {
    const ctx = new RepositoryContext();
    ctx.__registerForTest("other", {
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
    const sizeAfterFirst = ctx.__repoCountForTest();
    ctx.invalidateDiscovered();
    await ctx.detectFromPath(fixture.currentWorktree);
    expect(ctx.__repoCountForTest()).toBe(sizeAfterFirst);
  });
});
