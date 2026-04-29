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
    } finally {
      process.chdir(originalCwd);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("buildInstructions", () => {
  const baseInstructions =
    "Before running git worktree operations, call `detect_context` to learn the current repo, current branch, sibling repositories under the workspace root, and which capabilities are available. " +
    "It walks up to auto-discover sync-worktrees.config.{js,mjs,cjs,ts}, lists sibling worktrees, and reports per-capability {available, reason} so you can tell which tool is gated and why.";

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
        removeWorktree: { available: true },
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

  it("appends connect-time context when inside a managed worktree", () => {
    const discovered = makeDiscovered();
    const result = buildInstructions({ discovered });

    expect(result.startsWith(baseInstructions)).toBe(true);
    expect(result).toContain("Connect-time context");
    expect(result).toContain("kind: managed");
    expect(result).toContain("currentWorktreePath: /repos/my-repo/worktrees/feature-x");
    expect(result).toContain("currentBranch: feature-x");
    expect(result).toContain("configPath: /repos/sync-worktrees.config.js");
  });

  it("omits null fields from connect-time block", () => {
    const discovered = makeDiscovered({ currentBranch: null, configPath: null });
    const result = buildInstructions({ discovered });

    expect(result).toContain("Connect-time context");
    expect(result).toContain("kind: managed");
    expect(result).toContain("currentWorktreePath:");
    expect(result).not.toContain("currentBranch:");
    expect(result).not.toContain("configPath:");
  });

  it("does not include sibling worktree, sibling repo, or capability lists", () => {
    const discovered = makeDiscovered({
      allWorktrees: [
        { path: "/repos/my-repo/worktrees/main", branch: "main", isCurrent: false },
        { path: "/repos/my-repo/worktrees/feature-x", branch: "feature-x", isCurrent: true },
      ],
      siblingRepositories: [{ name: "other-repo", bareRepoPath: "/repos/other-repo/.bare", configMatched: true }],
    });
    const result = buildInstructions({ discovered });

    expect(result).not.toContain("main");
    expect(result).not.toContain("other-repo");
    expect(result).not.toContain("Sibling");
    expect(result).not.toContain("Disabled");
  });

  it("stays within size budget even with all fields populated", () => {
    const discovered = makeDiscovered();
    const result = buildInstructions({ discovered });
    expect(result.length).toBeLessThanOrEqual(baseInstructions.length + 500);
  });
});
