import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { RepositoryContext } from "../context";
import { buildInstructions, createServer } from "../server";

import type { DiscoveredRepoContext } from "../context";

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

describe("createServer", () => {
  beforeEach(() => {
    mockRemoteUrl.mockReset();
    mockWorktreeList.mockReset();
  });

  it("registers workspace resource", () => {
    const ctx = new RepositoryContext();
    const server = createServer(ctx);

    const registered = (server as any)._registeredResources as Record<string, unknown> | undefined;
    expect(registered).toBeDefined();
    expect(Object.keys(registered ?? {})).toContain("sync-worktrees://workspace");
  });

  it("workspace resource returns not-managed payload for non-git cwd", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-server-plain-"));
    const originalCwd = process.cwd();
    process.chdir(plain);

    try {
      const ctx = new RepositoryContext();
      const server = createServer(ctx);
      const registered = (server as any)._registeredResources as Record<
        string,
        { readCallback: (uri: URL) => Promise<{ contents: Array<{ text: string }> }> }
      >;
      const handler = registered["sync-worktrees://workspace"].readCallback;

      const result = await handler(new URL("sync-worktrees://workspace"));
      const payload = JSON.parse(result.contents[0].text);

      expect(payload.isWorktree).toBe(false);
      expect(payload.kind).toBe("unsupported");
    } finally {
      process.chdir(originalCwd);
      await fs.rm(plain, { recursive: true, force: true });
    }
  });

  it("workspace resource returns unsupported payload when detectFromPath throws", async () => {
    const ctx = new RepositoryContext();
    vi.spyOn(ctx, "detectFromPath").mockRejectedValue(new Error("boom"));
    const server = createServer(ctx);

    const registered = (server as any)._registeredResources as Record<
      string,
      { readCallback: (uri: URL) => Promise<{ contents: Array<{ text: string }> }> }
    >;
    const handler = registered["sync-worktrees://workspace"].readCallback;

    const result = await handler(new URL("sync-worktrees://workspace"));
    const payload = JSON.parse(result.contents[0].text);

    expect(payload.isWorktree).toBe(false);
    expect(payload.kind).toBe("unsupported");
    expect(Array.isArray(payload.notes)).toBe(true);
    expect(payload.notes.join(" ")).toContain("boom");
  });

  it("workspace resource returns discovered context when cwd is inside a worktree", async () => {
    const rootRaw = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-server-wt-"));
    const root = await fs.realpath(rootRaw);
    const bareRepo = path.join(root, ".bare", "repo");
    const adminDir = path.join(bareRepo, "worktrees", "feature-x");
    await fs.mkdir(adminDir, { recursive: true });
    const currentWorktree = path.join(root, "worktrees", "feature-x");
    await fs.mkdir(currentWorktree, { recursive: true });
    await fs.writeFile(path.join(currentWorktree, ".git"), `gitdir: ${adminDir}\n`, "utf-8");

    mockRemoteUrl.mockResolvedValue("https://github.com/test/repo.git\n");
    mockWorktreeList.mockResolvedValue([`worktree ${currentWorktree}`, "branch refs/heads/feature-x", ""].join("\n"));

    const originalCwd = process.cwd();
    process.chdir(currentWorktree);
    try {
      const ctx = new RepositoryContext();
      const server = createServer(ctx);
      const registered = (server as any)._registeredResources as Record<
        string,
        { readCallback: (uri: URL) => Promise<{ contents: Array<{ text: string }> }> }
      >;
      const handler = registered["sync-worktrees://workspace"].readCallback;

      const result = await handler(new URL("sync-worktrees://workspace"));
      expect(result.contents[0]).toMatchObject({ uri: "sync-worktrees://workspace", mimeType: "application/json" });

      const payload = JSON.parse(result.contents[0].text);
      expect(payload.isWorktree).toBe(true);
      expect(payload.currentBranch).toBe("feature-x");
      expect(Array.isArray(payload.configuredRepositories)).toBe(true);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("workspace resource includes server-wide configuredRepositories when config is loaded", async () => {
    const ctx = new RepositoryContext();
    vi.spyOn(ctx, "detectFromPath").mockResolvedValue({
      isWorktree: false,
      kind: "unsupported",
      currentBranch: null,
      currentWorktreePath: null,
      bareRepoPath: null,
      repoUrl: null,
      worktreeDir: null,
      allWorktrees: [],
      siblingRepositories: [],
      configPath: null,
      repoName: null,
      capabilities: {} as any,
      notes: [],
    } as any);
    vi.spyOn(ctx, "getConfiguredRepositorySummaries").mockResolvedValue([
      { name: "ui", mode: "clone", checkoutPath: "/ws/ui", isCurrent: false },
      { name: "frontend", mode: "worktree", worktreeDir: "/ws/frontend", isCurrent: true },
    ]);

    const server = createServer(ctx);
    const registered = (server as any)._registeredResources as Record<
      string,
      { readCallback: (uri: URL) => Promise<{ contents: Array<{ text: string }> }> }
    >;
    const handler = registered["sync-worktrees://workspace"].readCallback;

    const result = await handler(new URL("sync-worktrees://workspace"));
    const payload = JSON.parse(result.contents[0].text);

    expect(payload.configuredRepositories).toEqual([
      { name: "ui", mode: "clone", checkoutPath: "/ws/ui", isCurrent: false },
      { name: "frontend", mode: "worktree", worktreeDir: "/ws/frontend", isCurrent: true },
    ]);
  });
});

describe("buildInstructions", () => {
  const baseInstructions =
    "Call `detect_context` for the project map and live worktree state; `configuredRepositories` in its response is the server-wide loaded-config inventory. Use `set_current_repository` to switch repos. Auto-loads sync-worktrees.config.{js,mjs,cjs,ts} via walk-up. Repos run in one of two modes. worktree (default): a bare repo plus branch worktrees, with new worktrees created under worktreeDir. clone: one standalone checkout where worktreeDir is the repo root. create_worktree and update_worktree are worktree-mode only; in clone mode, use sync to update the checkout.";

  function makeDiscovered(overrides: Partial<DiscoveredRepoContext> = {}): DiscoveredRepoContext {
    return {
      isWorktree: true,
      kind: "managed",
      currentBranch: "feature-x",
      currentWorktreePath: "/repos/my-repo/worktrees/feature-x",
      bareRepoPath: null,
      repoUrl: null,
      worktreeDir: null,
      allWorktrees: [],
      siblingRepositories: [],
      configPath: "/repos/sync-worktrees.config.js",
      repoName: "my-repo",
      capabilities: {
        listWorktrees: { available: true },
        getStatus: { available: true },
        createWorktree: { available: true },
        updateWorktree: { available: true },
        sync: { available: true },
        initialize: { available: true },
      },
      notes: [],
      ...overrides,
    };
  }

  it("returns base instructions when snapshot is undefined", () => {
    expect(buildInstructions()).toBe(baseInstructions);
  });

  it("returns base instructions when discovered is null", () => {
    expect(buildInstructions({ discovered: null })).toBe(baseInstructions);
  });

  it("returns base instructions when isWorktree is false", () => {
    const discovered = makeDiscovered({ isWorktree: false, kind: "unsupported" });
    expect(buildInstructions({ discovered })).toBe(baseInstructions);
  });

  it("returns base instructions for unmanaged worktrees", () => {
    const discovered = makeDiscovered({ kind: "unmanaged" });
    expect(buildInstructions({ discovered })).toBe(baseInstructions);
  });

  it("does not embed configuredRepositories inventory in instructions", () => {
    const discovered = makeDiscovered();
    const result = buildInstructions({ discovered, configuredRepoCount: 2 });
    expect(result).not.toContain("Configured repositories:");
    expect(result).not.toContain("(clone)=");
    expect(result).not.toContain("(worktree)=");
  });

  it("appends connect-time context when inside a managed worktree", () => {
    const discovered = makeDiscovered();
    const result = buildInstructions({ discovered });

    expect(result.startsWith(baseInstructions)).toBe(true);
    expect(result).toContain("Connect-time:");
    expect(result).toContain("workspace=my-repo");
    expect(result).toContain("path=/repos/my-repo/worktrees/feature-x");
    expect(result).not.toContain("branch=");
    expect(result).toContain("config=/repos/sync-worktrees.config.js");
    expect(result).toContain("worktrees=0");
  });

  it("omits null fields from connect-time block", () => {
    const discovered = makeDiscovered({ currentBranch: null, configPath: null, repoName: null });
    const result = buildInstructions({ discovered });

    expect(result).toContain("Connect-time:");
    expect(result).toContain("path=");
    expect(result).not.toContain("workspace=");
    expect(result).not.toContain("config=");
  });

  it("includes configuredRepos count when configuredRepoCount provided", () => {
    const discovered = makeDiscovered();
    const result = buildInstructions({ discovered, configuredRepoCount: 4 });
    expect(result).toContain("configuredRepos=4");
  });

  it("omits configuredRepos field when configuredRepoCount missing", () => {
    const discovered = makeDiscovered();
    const result = buildInstructions({ discovered });
    expect(result).not.toContain("configuredRepos=");
  });

  it("counts worktrees in current repo without listing branch names or sibling repo names", () => {
    const discovered = makeDiscovered({
      allWorktrees: [
        { path: "/repos/my-repo/worktrees/main", branch: "main", isCurrent: false },
        { path: "/repos/my-repo/worktrees/feature-x", branch: "feature-x", isCurrent: true },
      ],
      siblingRepositories: [
        {
          name: "other-repo",
          bareRepoPath: "/repos/other-repo/.bare",
          worktreeDir: "/repos/other-repo/worktrees",
          repoUrl: "https://example.com/other-repo.git",
          present: true,
          configMatched: true,
        },
      ],
    });
    const result = buildInstructions({ discovered, configuredRepoCount: 3 });

    expect(result).toContain("worktrees=2");
    expect(result).toContain("configuredRepos=3");
    expect(result).not.toContain("/repos/my-repo/worktrees/main");
    expect(result).not.toContain("other-repo");
    expect(result).not.toContain("Disabled");
  });

  it("stays within size budget even with all fields populated", () => {
    const discovered = makeDiscovered();
    const result = buildInstructions({ discovered, configuredRepoCount: 10 });
    expect(result.length).toBeLessThanOrEqual(baseInstructions.length + 500);
  });
});
