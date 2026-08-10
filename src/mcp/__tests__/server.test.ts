import { spawn } from "node:child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as readline from "node:readline";

import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
} from "@modelcontextprotocol/server";
import { build } from "esbuild";
import { beforeEach, describe, expect, it, vi } from "vitest";

import packageJson from "../../../package.json" with { type: "json" };
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

describe("stdio protocol", () => {
  it("serves MCP 2026-07-28 and rejects a legacy handshake", async () => {
    const buildDir = await fs.mkdtemp(path.join(process.cwd(), ".mcp-stdio-test-"));
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-stdio-runtime-"));
    const entry = path.join(buildDir, "mcp-server.mjs");
    const children: ReturnType<typeof spawn>[] = [];

    try {
      await build({
        entryPoints: [path.join(process.cwd(), "src/mcp/index.ts")],
        outfile: entry,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        packages: "external",
        // Mirrors esbuild.config.js — the bundled entry reads the version from
        // this define, not from an import of package.json.
        define: { __SYNC_WORKTREES_VERSION__: JSON.stringify(packageJson.version) },
      });

      const startServer = () => {
        const child = spawn(process.execPath, [entry], {
          cwd: runtimeDir,
          env: { ...process.env, SYNC_WORKTREES_CONFIG: "" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        children.push(child);
        const lines = readline.createInterface({ input: child.stdout });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

        const request = (message: Record<string, unknown>): Promise<any> =>
          new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              cleanup();
              reject(new Error(`MCP response timed out. stderr: ${stderr}`));
            }, 5_000);
            const onLine = (line: string) => {
              const response = JSON.parse(line);
              if (response.id !== message.id) return;
              cleanup();
              resolve(response);
            };
            const onExit = () => {
              cleanup();
              reject(new Error(`MCP server exited before responding. stderr: ${stderr}`));
            };
            const cleanup = () => {
              clearTimeout(timeout);
              lines.off("line", onLine);
              child.off("exit", onExit);
            };

            lines.on("line", onLine);
            child.once("exit", onExit);
            child.stdin.write(`${JSON.stringify(message)}\n`);
          });

        return { child, request };
      };

      const modern = startServer();
      const envelope = {
        [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
        [CLIENT_CAPABILITIES_META_KEY]: {},
      };
      const discover = await modern.request({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { _meta: envelope },
      });
      expect(discover.result).toMatchObject({
        supportedVersions: ["2026-07-28"],
        // Cacheable, but private: the instructions embed connect-time workspace paths.
        ttlMs: 3_600_000,
        cacheScope: "private",
      });
      expect(discover.result._meta[SERVER_INFO_META_KEY]).toEqual({
        name: "sync-worktrees",
        version: packageJson.version,
      });

      const tools = await modern.request({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: { _meta: envelope },
      });
      // The registry is fixed at construction, so it is publicly cacheable.
      expect(tools.result).toMatchObject({ ttlMs: 3_600_000, cacheScope: "public" });
      expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "detect_context",
        "list_worktrees",
        "get_worktree_status",
        "create_worktree",
        "sync",
        "update_worktree",
        "initialize",
        "load_config",
        "set_current_repository",
      ]);
      // Every tool advertises an output schema (SEP-2106).
      for (const tool of tools.result.tools) {
        expect(tool.outputSchema, `${tool.name} outputSchema`).toMatchObject({ type: "object" });
      }

      const toolCall = await modern.request({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "detect_context", arguments: { path: runtimeDir }, _meta: envelope },
      });
      expect(toolCall.error).toBeUndefined();
      expect(toolCall.result.isError).not.toBe(true);
      expect(JSON.parse(toolCall.result.content[0].text)).toMatchObject({ isWorktree: false });
      // Results validate against the advertised schema and ship structuredContent.
      expect(toolCall.result.structuredContent).toMatchObject({ isWorktree: false });

      const legacy = startServer();
      const initialize = await legacy.request({
        jsonrpc: "2.0",
        id: 4,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-test", version: "1.0.0" },
        },
      });
      // 2025-era clients are still served, from the same tool registry.
      expect(initialize.error).toBeUndefined();
      expect(initialize.result).toMatchObject({
        protocolVersion: "2025-11-25",
        serverInfo: { name: "sync-worktrees", version: packageJson.version },
      });

      const legacyTools = await legacy.request({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });
      expect(legacyTools.result.tools.map((tool: { name: string }) => tool.name)).toEqual(
        tools.result.tools.map((tool: { name: string }) => tool.name),
      );

      const legacyCall = await legacy.request({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "detect_context", arguments: { path: runtimeDir } },
      });
      expect(legacyCall.error).toBeUndefined();
      expect(legacyCall.result.isError).not.toBe(true);
      expect(legacyCall.result.structuredContent).toMatchObject({ isWorktree: false });
    } finally {
      for (const child of children) child.kill();
      await fs.rm(buildDir, { recursive: true, force: true });
      await fs.rm(runtimeDir, { recursive: true, force: true });
    }
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
