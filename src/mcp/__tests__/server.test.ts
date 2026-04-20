import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { RepositoryContext } from "../context";
import { createServer } from "../server";

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
