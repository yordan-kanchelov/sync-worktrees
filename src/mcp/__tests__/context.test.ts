import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RepositoryContext } from "../context";

const mockRemoteUrl = vi.fn<any>();
const mockWorktreeList = vi.fn<any>();

vi.mock("simple-git", () => {
  return {
    default: vi.fn((basePath?: string) => ({
      remote: (...args: unknown[]) => (mockRemoteUrl as any)(...args),
      raw: (...args: unknown[]) => (mockWorktreeList as any)(basePath, ...args),
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

      expect(result.siblingRepositories.length).toBe(2);
      const names = result.siblingRepositories.map((s) => s.name).sort();
      expect(names).toEqual(["repo-sibling-a", "repo-sibling-b"]);
      for (const sib of result.siblingRepositories) {
        expect(sib.bareRepoPath).toMatch(/\.bare$/);
        expect(sib.worktreeDir).toBeNull();
        expect(sib.repoUrl).toBeNull();
        expect(sib.present).toBe(true);
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
      expect(matched?.repoUrl).toBe("https://github.com/test/sibling.git");
      expect(matched?.worktreeDir).toBe(path.join(siblingA, "worktrees"));
      expect(matched?.present).toBe(true);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("populates config-driven sibling repos with nested worktreeDir even when bare repo is missing", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-siblings-nested-cfg-"));
    try {
      const currentBare = path.join(workspace, ".bare", "amusnet-react-ui");
      const adminDir = path.join(currentBare, "worktrees", "stream-test");
      await fs.mkdir(adminDir, { recursive: true });
      const currentWt = path.join(workspace, "amusnet-react-ui", "stream-test");
      await fs.mkdir(currentWt, { recursive: true });
      await fs.writeFile(path.join(currentWt, ".git"), `gitdir: ${adminDir}\n`, "utf-8");

      const rouletteBare = path.join(workspace, ".bare", "roulette-frontend");
      const rouletteWorktreeDir = path.join(workspace, "frontend", "roulette-frontend");
      const configPath = path.join(workspace, "sync-worktrees.config.js");
      const cfgBody = `export default { repositories: [
        { name: "amusnet-react-ui", repoUrl: "https://github.com/test/amusnet-react-ui.git", bareRepoDir: "./.bare/amusnet-react-ui", worktreeDir: "./amusnet-react-ui", cronSchedule: "0 * * * *", runOnce: true },
        { name: "roulette-frontend", repoUrl: "https://github.com/test/roulette-frontend.git", bareRepoDir: "./.bare/roulette-frontend", worktreeDir: "./frontend/roulette-frontend", cronSchedule: "0 * * * *", runOnce: true }
      ] };`;
      await fs.writeFile(configPath, cfgBody, "utf-8");

      mockRemoteUrl.mockResolvedValue("https://github.com/test/amusnet-react-ui.git\n");
      mockWorktreeList.mockResolvedValue([`worktree ${currentWt}`, "branch refs/heads/stream-test", ""].join("\n"));

      const ctx = new RepositoryContext();
      const result = await ctx.detectFromPath(currentWt);

      expect(result.configPath).toBe(configPath);
      expect(result.repoName).toBe("amusnet-react-ui");
      expect(result.siblingRepositories).toEqual([
        {
          name: "roulette-frontend",
          bareRepoPath: rouletteBare,
          worktreeDir: rouletteWorktreeDir,
          repoUrl: "https://github.com/test/roulette-frontend.git",
          present: false,
          configMatched: true,
        },
      ]);
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

  it("detects a configured clone-mode checkout as managed", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-clone-cfg-"));
    try {
      const cloneDir = path.join(workspace, "slots", "game-platform");
      await fs.mkdir(path.join(cloneDir, ".git"), { recursive: true });
      const nestedPath = path.join(cloneDir, "client");
      await fs.mkdir(nestedPath, { recursive: true });

      const configPath = path.join(workspace, "sync-worktrees.config.js");
      const cfgBody = `export default { repositories: [
        { name: "game-platform-slots", repoUrl: "https://github.com/test/game-platform.git", worktreeDir: "./slots/game-platform", mode: "clone", cronSchedule: "0 * * * *", runOnce: true }
      ] };`;
      await fs.writeFile(configPath, cfgBody, "utf-8");

      mockWorktreeList.mockImplementation((basePath: unknown, args: unknown) => {
        if (basePath === cloneDir && Array.isArray(args) && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
          return Promise.resolve("master\n");
        }
        return Promise.reject(new Error("unexpected git call"));
      });

      const ctx = new RepositoryContext();
      await ctx.loadConfig(configPath);
      const result = await ctx.detectFromPath(nestedPath);
      const details = await ctx.getAllConfiguredWorktreeDetails(result.currentWorktreePath);

      expect(result.kind).toBe("managed");
      expect(result.repoName).toBe("game-platform-slots");
      expect(result.bareRepoPath).toBeNull();
      expect(result.currentWorktreePath).toBe(cloneDir);
      expect(result.allWorktrees).toEqual([{ path: cloneDir, branch: "master", isCurrent: true }]);
      expect(result.capabilities.listWorktrees.available).toBe(true);
      expect(result.capabilities.getStatus.available).toBe(true);
      expect(result.capabilities.createWorktree.available).toBe(false);
      expect(result.capabilities.updateWorktree.available).toBe(false);
      expect(details.worktreesByRepo["game-platform-slots"]).toEqual([
        { path: cloneDir, branch: "master", isCurrent: true },
      ]);
      expect(details.errorsByRepo).toEqual({});
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not report configured clone-mode branch when checkout branch is unreadable", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-clone-broken-branch-"));
    try {
      const cloneDir = path.join(workspace, "slots", "game-platform");
      await fs.mkdir(path.join(cloneDir, ".git"), { recursive: true });

      const configPath = path.join(workspace, "sync-worktrees.config.js");
      const cfgBody = `export default { repositories: [
        { name: "game-platform-slots", repoUrl: "https://github.com/test/game-platform.git", worktreeDir: "./slots/game-platform", mode: "clone", branch: "configured-main", cronSchedule: "0 * * * *", runOnce: true }
      ] };`;
      await fs.writeFile(configPath, cfgBody, "utf-8");

      mockWorktreeList.mockImplementation((basePath: unknown, args: unknown) => {
        if (basePath === cloneDir && Array.isArray(args) && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
          return Promise.reject(new Error("not a valid checkout"));
        }
        return Promise.reject(new Error("unexpected git call"));
      });

      const ctx = new RepositoryContext();
      await ctx.loadConfig(configPath);
      const result = await ctx.detectFromPath(cloneDir);

      expect(result.currentBranch).toBeNull();
      expect(result.allWorktrees).toEqual([{ path: cloneDir, branch: "unknown", isCurrent: true }]);
      expect(result.notes).toContain("Could not read clone-mode branch: not a valid checkout");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("RepositoryContext.getAllConfiguredWorktreeDetails", () => {
  beforeEach(() => {
    mockRemoteUrl.mockReset();
    mockWorktreeList.mockReset();
  });

  it("returns configured repo worktrees keyed by repo name", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-all-worktrees-"));
    try {
      const currentBare = path.join(workspace, ".bare", "repo-a");
      const currentAdmin = path.join(currentBare, "worktrees", "main");
      await fs.mkdir(currentAdmin, { recursive: true });
      const currentWt = path.join(workspace, "repo-a", "main");
      await fs.mkdir(currentWt, { recursive: true });
      await fs.writeFile(path.join(currentWt, ".git"), `gitdir: ${currentAdmin}\n`, "utf-8");

      const siblingBare = path.join(workspace, ".bare", "repo-b");
      await fs.mkdir(path.join(siblingBare, "worktrees", "feature-b"), { recursive: true });
      const siblingWt = path.join(workspace, "frontend", "repo-b", "feature-b");

      const configPath = path.join(workspace, "sync-worktrees.config.js");
      const cfgBody = `export default { repositories: [
        { name: "repo-a", repoUrl: "https://github.com/test/repo-a.git", bareRepoDir: "./.bare/repo-a", worktreeDir: "./repo-a", cronSchedule: "0 * * * *", runOnce: true },
        { name: "repo-b", repoUrl: "https://github.com/test/repo-b.git", bareRepoDir: "./.bare/repo-b", worktreeDir: "./frontend/repo-b", cronSchedule: "0 * * * *", runOnce: true }
      ] };`;
      await fs.writeFile(configPath, cfgBody, "utf-8");

      mockRemoteUrl.mockResolvedValue("https://github.com/test/repo-a.git\n");
      mockWorktreeList.mockImplementation((basePath: unknown) => {
        if (basePath === siblingBare) {
          return Promise.resolve([`worktree ${siblingWt}`, "branch refs/heads/feature-b", ""].join("\n"));
        }
        return Promise.resolve([`worktree ${currentWt}`, "branch refs/heads/main", ""].join("\n"));
      });

      const ctx = new RepositoryContext();
      const discovered = await ctx.detectFromPath(currentWt);
      const details = await ctx.getAllConfiguredWorktreeDetails(discovered.currentWorktreePath);

      expect(Object.keys(details.worktreesByRepo)).toEqual(["repo-a", "repo-b"]);
      expect(details.worktreesByRepo["repo-a"]).toEqual([{ path: currentWt, branch: "main", isCurrent: true }]);
      expect(details.worktreesByRepo["repo-b"]).toEqual([{ path: siblingWt, branch: "feature-b", isCurrent: false }]);
      expect(details.errorsByRepo).toEqual({});
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("surfaces per-repo worktree enumeration errors", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-all-worktrees-error-"));
    try {
      const currentBare = path.join(workspace, ".bare", "repo-a");
      const currentAdmin = path.join(currentBare, "worktrees", "main");
      await fs.mkdir(currentAdmin, { recursive: true });
      const currentWt = path.join(workspace, "repo-a", "main");
      await fs.mkdir(currentWt, { recursive: true });
      await fs.writeFile(path.join(currentWt, ".git"), `gitdir: ${currentAdmin}\n`, "utf-8");

      const siblingBare = path.join(workspace, ".bare", "repo-b");
      await fs.mkdir(siblingBare, { recursive: true });

      const configPath = path.join(workspace, "sync-worktrees.config.js");
      const cfgBody = `export default { repositories: [
        { name: "repo-a", repoUrl: "https://github.com/test/repo-a.git", bareRepoDir: "./.bare/repo-a", worktreeDir: "./repo-a", cronSchedule: "0 * * * *", runOnce: true },
        { name: "repo-b", repoUrl: "https://github.com/test/repo-b.git", bareRepoDir: "./.bare/repo-b", worktreeDir: "./repo-b", cronSchedule: "0 * * * *", runOnce: true }
      ] };`;
      await fs.writeFile(configPath, cfgBody, "utf-8");

      mockRemoteUrl.mockResolvedValue("https://github.com/test/repo-a.git\n");
      mockWorktreeList.mockImplementation((basePath: unknown) => {
        if (basePath === siblingBare) {
          return Promise.reject(new Error("repo-b corrupt"));
        }
        return Promise.resolve([`worktree ${currentWt}`, "branch refs/heads/main", ""].join("\n"));
      });

      const ctx = new RepositoryContext();
      const discovered = await ctx.detectFromPath(currentWt);
      const details = await ctx.getAllConfiguredWorktreeDetails(discovered.currentWorktreePath);

      expect(details.worktreesByRepo["repo-a"]).toEqual([{ path: currentWt, branch: "main", isCurrent: true }]);
      expect(details.worktreesByRepo["repo-b"]).toEqual([]);
      expect(details.errorsByRepo["repo-b"]).toContain("repo-b corrupt");
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

describe("RepositoryContext.autoSelectCurrentRepoIfSingleConfig", () => {
  function registerConfigured(ctx: RepositoryContext, name: string): void {
    ctx.__registerForTest(name, {
      config: {
        repoUrl: `https://example.com/${name}.git`,
        bareRepoDir: `/repos/${name}/.bare`,
        worktreeDir: `/repos/${name}/worktrees`,
        cronSchedule: "0 * * * *",
        runOnce: true,
      },
      source: "config" as const,
    });
  }

  function registerDetected(ctx: RepositoryContext, name: string): void {
    ctx.__registerForTest(name, {
      config: {
        repoUrl: `https://example.com/${name}.git`,
        bareRepoDir: `/repos/${name}/.bare`,
        worktreeDir: `/repos/${name}/worktrees`,
        cronSchedule: "0 * * * *",
        runOnce: true,
      },
      source: "detected" as const,
    });
  }

  it("selects the single configured repo when currentRepo is null", () => {
    const ctx = new RepositoryContext();
    registerConfigured(ctx, "only-one");

    const result = ctx.autoSelectCurrentRepoIfSingleConfig();
    expect(result).toBe("only-one");
    expect(ctx.getCurrentRepo()).toBe("only-one");
  });

  it("does nothing when multiple configured repos exist", () => {
    const ctx = new RepositoryContext();
    registerConfigured(ctx, "alpha");
    registerConfigured(ctx, "beta");

    const result = ctx.autoSelectCurrentRepoIfSingleConfig();
    expect(result).toBeNull();
    expect(ctx.getCurrentRepo()).toBeNull();
  });

  it("ignores detected-source entries when counting", () => {
    const ctx = new RepositoryContext();
    registerDetected(ctx, "detected-only");

    const result = ctx.autoSelectCurrentRepoIfSingleConfig();
    expect(result).toBeNull();
    expect(ctx.getCurrentRepo()).toBeNull();
  });

  it("refuses to select when any detected entry exists (ambiguity evidence)", () => {
    const ctx = new RepositoryContext();
    registerConfigured(ctx, "the-one");
    registerDetected(ctx, "cwd-detected");

    const result = ctx.autoSelectCurrentRepoIfSingleConfig();
    expect(result).toBeNull();
    expect(ctx.getCurrentRepo()).toBeNull();
  });

  it("does not overwrite an existing currentRepo", () => {
    const ctx = new RepositoryContext();
    registerConfigured(ctx, "first");
    registerConfigured(ctx, "second");
    ctx.__setCurrentRepoForTest("second");

    const result = ctx.autoSelectCurrentRepoIfSingleConfig();
    expect(result).toBe("second");
    expect(ctx.getCurrentRepo()).toBe("second");
  });
});

describe("RepositoryContext.getService error messages", () => {
  it("throws diagnostic error when no repo selected and none loaded", async () => {
    const ctx = new RepositoryContext({ launchCwd: "/tmp/somewhere" });

    await expect(ctx.getService()).rejects.toThrow(/launchCwd=\/tmp\/somewhere/);
    await expect(ctx.getService()).rejects.toThrow(/configPath=none/);
    await expect(ctx.getService()).rejects.toThrow(/loadedRepos=0/);
    await expect(ctx.getService()).rejects.toThrow(/detect_context/);
    await expect(ctx.getService()).rejects.toThrow(/load_config/);
    await expect(ctx.getService()).rejects.toThrow(/SYNC_WORKTREES_CONFIG/);
  });

  it("lists configured repos when multiple are loaded but none selected", async () => {
    const ctx = new RepositoryContext({ launchCwd: "/work" });
    ctx.__registerForTest("alpha", {
      config: {
        repoUrl: "https://example.com/alpha.git",
        bareRepoDir: "/repos/alpha/.bare",
        worktreeDir: "/repos/alpha/wt",
        cronSchedule: "0 * * * *",
        runOnce: true,
      },
      source: "config" as const,
    });
    ctx.__registerForTest("beta", {
      config: {
        repoUrl: "https://example.com/beta.git",
        bareRepoDir: "/repos/beta/.bare",
        worktreeDir: "/repos/beta/wt",
        cronSchedule: "0 * * * *",
        runOnce: true,
      },
      source: "config" as const,
    });

    await expect(ctx.getService()).rejects.toThrow(/loadedRepos=2/);
    await expect(ctx.getService()).rejects.toThrow(/Configured repos: \[alpha, beta\]/);
    await expect(ctx.getService()).rejects.toThrow(/set_current_repository/);
  });

  it("lists detected repos with location when no current repo selected", async () => {
    const ctx = new RepositoryContext({ launchCwd: "/work" });
    ctx.__registerForTest("alpha", {
      config: {
        repoUrl: "https://example.com/alpha.git",
        bareRepoDir: "/repos/alpha/.bare",
        worktreeDir: "/repos/alpha/wt",
        cronSchedule: "0 * * * *",
        runOnce: true,
      },
      source: "config" as const,
    });
    ctx.__registerForTest("__auto_detected__:other@/repos/other/.bare", {
      config: {
        repoUrl: "https://example.com/other.git",
        bareRepoDir: "/repos/other/.bare",
        worktreeDir: "/repos/other/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: true,
      },
      source: "detected" as const,
    });

    await expect(ctx.getService()).rejects.toThrow(
      /Detected repos: \[__auto_detected__:other@\/repos\/other\/\.bare \(\/repos\/other\/\.bare\)\]/,
    );
    await expect(ctx.getService()).rejects.toThrow(/Configured repos: \[alpha\]/);
    await expect(ctx.getService()).rejects.toThrow(/set_current_repository with one of the repo names above/);
  });

  it("throws diagnostic error when explicit repoName is unknown", async () => {
    const ctx = new RepositoryContext();
    ctx.__registerForTest("known", {
      config: {
        repoUrl: "https://example.com/known.git",
        bareRepoDir: "/repos/known/.bare",
        worktreeDir: "/repos/known/wt",
        cronSchedule: "0 * * * *",
        runOnce: true,
      },
      source: "config" as const,
    });

    await expect(ctx.getService("missing")).rejects.toThrow(/'missing' not found/);
    await expect(ctx.getService("missing")).rejects.toThrow(/Known repos: \[known\]/);
  });
});

describe("RepositoryContext launchCwd", () => {
  it("defaults launchCwd to process.cwd()", () => {
    const ctx = new RepositoryContext();
    expect(ctx.getLaunchCwd()).toBe(path.resolve(process.cwd()));
  });

  it("resolves explicit launchCwd to an absolute path", () => {
    const ctx = new RepositoryContext({ launchCwd: "/some/relative/../abs/path" });
    expect(ctx.getLaunchCwd()).toBe(path.resolve("/some/relative/../abs/path"));
  });
});
