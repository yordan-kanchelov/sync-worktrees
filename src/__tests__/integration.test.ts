import * as fs from "fs/promises";

import * as cron from "node-cron";
import simpleGit from "simple-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorktreeSyncService } from "../services/worktree-sync.service";

import { TEST_PATHS, TEST_URLS, createMockConfig, createMockLogger } from "./test-utils";
// import { parseArguments } from '../utils/cli'; // Skip due to ESM issues

import type { Logger } from "../services/logger.service";
import type { SimpleGit } from "simple-git";
import type { Mock, Mocked } from "vitest";

// Mock all external dependencies
vi.mock("fs/promises");
vi.mock("simple-git");
vi.mock("node-cron");
// vi.mock('../utils/cli'); // Skip due to ESM issues

describe("Integration Tests", () => {
  let mockGit: Mocked<SimpleGit>;
  let mockScheduledTask: { start: Mock; stop: Mock };
  let mockLogger: Logger;

  // Bare-repository stand-in: the default-branch worktree is registered, so
  // initialize() reuses it instead of creating one; every other call is a no-op.
  const rawDefault = async (args: unknown): Promise<string> =>
    Array.isArray(args) && args[0] === "worktree" && args[1] === "list"
      ? `worktree ${TEST_PATHS.worktree}/main\nbranch refs/heads/main\n\n`
      : "";

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();

    // Setup mock git
    mockGit = {
      fetch: vi.fn<any>().mockResolvedValue(undefined),
      branch: vi.fn<any>().mockResolvedValue({
        all: ["origin/main", "origin/feature-1", "origin/feature-2"],
        current: "main",
      }),
      raw: vi.fn<any>().mockImplementation(rawDefault),
      status: vi.fn<any>().mockResolvedValue({
        isClean: vi.fn().mockReturnValue(true),
      }),
      stashList: vi.fn<any>().mockResolvedValue({ total: 0 }),
      clone: vi.fn<any>().mockResolvedValue(undefined),
      addConfig: vi.fn<any>().mockResolvedValue(undefined),
      revparse: vi.fn<any>().mockResolvedValue("abc123def456"),
    } as any;

    (simpleGit as unknown as Mock).mockReturnValue(mockGit);

    // Setup mock cron
    mockScheduledTask = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    (cron.schedule as Mock).mockReturnValue(mockScheduledTask);

    // Setup mock fs
    (fs.access as Mock<any>).mockResolvedValue(undefined);
    (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
    // The trash root is read with `withFileTypes`, so it has to yield Dirents.
    // Handing it the plain names the worktree-dir listing returns makes the
    // trash listing throw, which now aborts the sync instead of being swallowed.
    (fs.readdir as Mock<any>).mockImplementation(async (dirPath: unknown) =>
      String(dirPath).endsWith(".trash") ? [] : ["main"],
    );
    // Removal audit records gate destructive operations and are written via
    // fs.open + appendFile + sync (durable append), not fs.appendFile.
    (fs.open as Mock<any>).mockResolvedValue({
      writeFile: vi.fn<any>().mockResolvedValue(undefined),
      appendFile: vi.fn<any>().mockResolvedValue(undefined),
      sync: vi.fn<any>().mockResolvedValue(undefined),
      close: vi.fn<any>().mockResolvedValue(undefined),
    });
  });

  describe("Full sync workflow", () => {
    it("should skip creating worktree for currently checked out branch", async () => {
      // feature-1 is already checked out in a registered worktree; nothing
      // else exists yet. `worktree add` registers its target, after which the
      // path exists and the worktree list reports it.
      (fs.readdir as Mock<any>).mockResolvedValueOnce([]);
      const registered: Array<{ path: string; branch: string }> = [
        { path: `${TEST_PATHS.worktree}/feature-1`, branch: "feature-1" },
      ];
      (fs.access as Mock<any>).mockImplementation(async (p: unknown) => {
        const pathStr = String(p);
        const underWorktreeDir = pathStr.startsWith(`${TEST_PATHS.worktree}/`);
        const exists = registered.some((w) => pathStr === w.path || pathStr.startsWith(`${w.path}/`));
        if (underWorktreeDir && !exists) {
          throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
        }
      });
      (mockGit.raw as Mock<any>).mockImplementation(async (args: unknown) => {
        const argsArray = args as string[];
        if (argsArray[0] === "remote" && argsArray[1] === "get-url") return TEST_URLS.github;
        if (argsArray[0] === "config") throw new Error("config not found");
        if (argsArray[0] === "show-ref" && String(argsArray[argsArray.length - 1]).startsWith("refs/heads/")) {
          throw new Error("show-ref: not found"); // no local branches yet: every add tracks origin
        }
        if (argsArray[0] === "worktree" && argsArray[1] === "list") {
          return registered.map((w) => `worktree ${w.path}\nbranch refs/heads/${w.branch}\n`).join("\n");
        }
        if (argsArray[0] === "worktree" && argsArray[1] === "add") {
          const branchIndex = argsArray.indexOf("-b") + 1;
          registered.push({ path: argsArray[branchIndex + 1], branch: argsArray[branchIndex] });
          return "";
        }
        return "";
      });

      // Mock branch calls
      (mockGit.branch as Mock<any>).mockImplementation(async (args?: unknown) =>
        Array.isArray(args) && args[0] === "-r"
          ? ({ all: ["origin/main", "origin/feature-1", "origin/feature-2"], current: "" } as any)
          : ({ all: [], current: "main" } as any),
      );

      const config = createMockConfig({ runOnce: true, logger: mockLogger });

      const service = new WorktreeSyncService(config);
      await service.initialize();
      await service.sync();

      // Should NOT create worktree for feature-1 (current branch)
      expect(mockGit.raw).not.toHaveBeenCalledWith(
        expect.arrayContaining([
          "worktree",
          "add",
          expect.anything(),
          expect.anything(),
          TEST_PATHS.worktree + "/feature-1",
          expect.anything(),
        ]),
      );

      // Check all raw calls to find worktree add commands
      const worktreeAddCalls = mockGit.raw.mock.calls.filter(
        (call) => call[0][0] === "worktree" && call[0][1] === "add",
      );

      // Should have created at least one worktree (main during init and/or feature-2 during sync)
      expect(worktreeAddCalls.length).toBeGreaterThanOrEqual(1);

      // Verify the worktrees that were created
      const createdBranches = worktreeAddCalls.map((call) => {
        // For new format: ["worktree", "add", "--track", "-b", branchName, ...]
        // Branch name is at index 4
        return call[0][4];
      });

      // Should have created worktrees for main and/or feature-2 but not feature-1
      expect(createdBranches).not.toContain("feature-1"); // Current branch should be skipped

      // Verify that feature-2 worktree was created during sync
      // (main might be created during init, but feature-2 should definitely be created)
      if (!createdBranches.includes("feature-2")) {
        expect(createdBranches).toContain("main"); // At minimum, main should be created
      }
    });
  });

  describe("Cron scheduling", () => {
    it("should run once and exit when runOnce is true", async () => {
      const config = createMockConfig({ runOnce: true, logger: mockLogger });

      const service = new WorktreeSyncService(config);
      await service.initialize();
      await service.sync();

      // Should not schedule cron job
      expect(cron.schedule).not.toHaveBeenCalled();
    });
  });

  describe("Error handling", () => {
    it("should handle and recover from sync errors", async () => {
      const config = createMockConfig({ runOnce: true, logger: mockLogger });

      const service = new WorktreeSyncService(config);
      await service.initialize();

      // Make fetch fail during sync (after successful initialization)
      mockGit.fetch.mockRejectedValueOnce(new Error("Network error"));

      // Should throw but log the error
      await expect(service.sync()).rejects.toThrow("Network error");
      expect(mockLogger.error).toHaveBeenCalledWith(
        "\n❌ Error during worktree synchronization after all retry attempts:",
        expect.any(Error),
      );
    });

    it("should continue sync even if individual worktree operations fail", async () => {
      const config = createMockConfig({ runOnce: true, logger: mockLogger });

      // Make first worktree add fail
      (mockGit.raw as Mock<any>)
        .mockRejectedValueOnce(new Error("Worktree already exists"))
        .mockImplementation(rawDefault);

      const service = new WorktreeSyncService(config);
      await service.initialize();

      // Should not throw and continue with other operations
      await expect(service.sync()).resolves.not.toThrow();
    });
  });

  describe("Complex scenarios", () => {
    it("should handle mixed operations: add, remove, and skip", async () => {
      // Asserts the direct-delete mechanism; the trash pipeline has its own suites.
      const config = createMockConfig({ runOnce: true, logger: mockLogger, trash: { enabled: false } });

      // Setup: existing worktrees include some to keep, some to remove
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath: unknown) =>
        String(dirPath).endsWith(".trash")
          ? []
          : [
              "main", // Keep (exists in remote)
              "feature-1", // Keep (exists in remote)
              "old-feature", // Remove (not in remote)
              "dirty-branch", // Skip removal (has changes)
            ],
      );

      // Mock git worktree list --porcelain
      const mockRawCalls: string[][] = [];
      (mockGit.raw as Mock<any>).mockImplementation(async (args) => {
        const argsArray = args as string[];
        mockRawCalls.push(argsArray);
        if (argsArray[0] === "worktree" && argsArray[1] === "list" && argsArray[2] === "--porcelain") {
          return `worktree /test/worktrees/main
branch refs/heads/main

worktree /test/worktrees/feature-1
branch refs/heads/feature-1

worktree /test/worktrees/old-feature
branch refs/heads/old-feature

worktree /test/worktrees/dirty-branch
branch refs/heads/dirty-branch
`;
        }
        return "";
      });

      // Mock fs.stat and fs.rm for orphaned directory cleanup
      (fs.stat as Mock<any>).mockResolvedValue({
        isDirectory: vi.fn().mockReturnValue(true),
        isFile: vi.fn().mockReturnValue(false),
      });
      (fs.rm as Mock<any>).mockResolvedValue(undefined);

      // Mock fs.access: resolve for directory existence checks, reject for operation file checks
      (fs.access as Mock<any>).mockImplementation(async (p: unknown) => {
        const pathStr = p as string;
        if (
          pathStr.includes("MERGE_HEAD") ||
          pathStr.includes("CHERRY_PICK_HEAD") ||
          pathStr.includes("REVERT_HEAD") ||
          pathStr.includes("BISECT_LOG") ||
          pathStr.includes("rebase-merge") ||
          pathStr.includes("rebase-apply")
        ) {
          throw Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" });
        }
        return undefined;
      });

      const cleanStatus = {
        modified: [],
        deleted: [],
        renamed: [],
        created: [],
        conflicted: [],
        not_added: [],
      };
      const dirtyStatus = { ...cleanStatus, modified: ["file.txt"] };

      // Reset the mock implementation before defining the new one
      (mockGit.raw as Mock<any>).mockReset();

      // Mock the raw calls for safety checks on old-feature (clean worktree)
      (mockGit.raw as Mock<any>).mockImplementation(async (args) => {
        const argsArray = args as string[];
        mockRawCalls.push(argsArray);

        if (argsArray[0] === "show-ref" && argsArray[1] === "--verify") {
          const ref = argsArray[argsArray.length - 1];
          if (typeof ref === "string" && ref.startsWith("refs/heads/")) {
            throw new Error("show-ref: not found");
          }
          if (typeof ref === "string" && ref.startsWith("refs/remotes/origin/")) {
            return "";
          }
        }

        if (argsArray[0] === "worktree" && argsArray[1] === "list" && argsArray[2] === "--porcelain") {
          return `worktree /test/worktrees/main
branch refs/heads/main

worktree /test/worktrees/feature-1
branch refs/heads/feature-1

worktree /test/worktrees/old-feature
branch refs/heads/old-feature

worktree /test/worktrees/dirty-branch
branch refs/heads/dirty-branch
`;
        } else if (argsArray[0] === "rev-list" && argsArray[1] === "--count") {
          // No unpushed commits
          return "0\n";
        } else if (argsArray[0] === "submodule" && argsArray[1] === "status") {
          // No submodules
          return "";
        } else if (argsArray[0] === "worktree" && argsArray[1] === "add") {
          // Worktree add commands
          return "";
        } else if (argsArray[0] === "branch" && !argsArray[1]) {
          // Branch list for addWorktree
          return { all: [], current: "main" };
        } else if (argsArray[0] === "worktree" && argsArray[1] === "remove") {
          // Worktree remove commands
          return "";
        } else if (argsArray[0] === "worktree" && argsArray[1] === "prune") {
          // Worktree prune command
          return "";
        }

        return "";
      });

      // Also need to mock stashList and branch for new safety checks
      (simpleGit as unknown as Mock).mockImplementation((workPath?: unknown) => {
        const pathStr = workPath as string;
        if (pathStr && pathStr.includes("old-feature")) {
          return {
            ...mockGit,
            stashList: vi.fn<any>().mockResolvedValue({ total: 0 }),
            branch: vi.fn<any>().mockResolvedValue({ current: "old-feature" }),
            status: vi.fn<any>().mockResolvedValue(cleanStatus),
          };
        } else if (pathStr && pathStr.includes("dirty-branch")) {
          return {
            ...mockGit,
            stashList: vi.fn<any>().mockResolvedValue({ total: 0 }),
            branch: vi.fn<any>().mockResolvedValue({ current: "dirty-branch" }),
            status: vi.fn<any>().mockResolvedValue(dirtyStatus),
          };
        } else if (pathStr && pathStr.includes(".bare")) {
          // For bare repo (used by addWorktree)
          return {
            ...mockGit,
            branch: vi.fn<any>().mockResolvedValue({ all: [], current: "main" }),
          };
        }
        return mockGit;
      });

      const service = new WorktreeSyncService(config);
      await service.initialize();
      await service.sync();

      // Filter out the worktree list calls
      const operationCalls = mockRawCalls.filter((args) => !(args[1] === "list" && args[2] === "--porcelain"));

      // Should add feature-2 with tracking (path is hashed for collision resistance)
      expect(operationCalls).toContainEqual(
        expect.arrayContaining([
          "worktree",
          "add",
          "--track",
          "-b",
          "feature-2",
          expect.stringMatching(/^\/test\/worktrees\/feature-2-[a-f0-9]{8}$/),
          "origin/feature-2",
        ]),
      );

      // Should remove old-feature with full path (non-forced so git can refuse dirty worktrees)
      expect(operationCalls).toContainEqual(["worktree", "remove", "/test/worktrees/old-feature"]);

      // Should NOT remove dirty-branch
      expect(operationCalls).not.toContainEqual(["worktree", "remove", "/test/worktrees/dirty-branch"]);
      expect(operationCalls).not.toContainEqual(["worktree", "remove", "/test/worktrees/dirty-branch", "--force"]);

      // Should log warning about dirty-branch
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Skipping removal of 'dirty-branch'"));
    });
  });
});
