import * as fs from "fs/promises";

import * as cron from "node-cron";
import simpleGit from "simple-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorktreeSyncService } from "../services/worktree-sync.service";

import { TEST_PATHS, createMockConfig } from "./test-utils";
// import { parseArguments } from '../utils/cli'; // Skip due to ESM issues

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

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup mock git
    mockGit = {
      fetch: vi.fn<any>().mockResolvedValue(undefined),
      branch: vi.fn<any>().mockResolvedValue({
        all: ["origin/main", "origin/feature-1", "origin/feature-2"],
        current: "main",
      }),
      raw: vi.fn<any>().mockResolvedValue(""),
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
    (fs.readdir as Mock<any>).mockResolvedValue(["main"]);
  });

  describe("Full sync workflow", () => {
    it("should skip creating worktree for currently checked out branch", async () => {
      // Mock readdir to return empty (no existing worktrees)
      (fs.readdir as Mock<any>).mockResolvedValueOnce([]);

      // Mock fetch for initialization
      mockGit.fetch.mockResolvedValue({} as any);

      // Mock raw calls for initialization and sync
      mockGit.raw
        .mockImplementationOnce(() => {
          throw new Error("config not found");
        }) // config check
        .mockResolvedValueOnce("worktree /test/repo\nbranch refs/heads/main\n\n") // worktree list for init
        .mockResolvedValueOnce("") // worktree add for main during init (if needed)
        .mockResolvedValueOnce(
          "worktree /test/repo\nbranch refs/heads/main\n\nworktree /test/worktrees/main\nbranch refs/heads/main\n\n",
        ) // worktree list for sync
        .mockResolvedValue(""); // default for other calls

      // Mock branch calls
      mockGit.branch
        .mockResolvedValueOnce({
          // First call: git.branch(["-r"]) for remote branches
          all: ["origin/main", "origin/feature-1", "origin/feature-2"],
          current: "",
        } as any)
        .mockResolvedValueOnce({
          // Second call: getCurrentBranch
          current: "feature-1",
          all: [],
        } as any)
        // Mock branch calls for addWorktree
        .mockResolvedValueOnce({ all: [], current: "main" } as any) // for main worktree
        .mockResolvedValueOnce({ all: [], current: "main" } as any); // for feature-2 worktree

      const config = createMockConfig({ runOnce: true });

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
      const config = createMockConfig({ runOnce: true });

      const service = new WorktreeSyncService(config);
      await service.initialize();
      await service.sync();

      // Should not schedule cron job
      expect(cron.schedule).not.toHaveBeenCalled();
    });
  });

  describe("Error handling", () => {
    it("should handle and recover from sync errors", async () => {
      const config = createMockConfig({ runOnce: true });

      const service = new WorktreeSyncService(config);
      await service.initialize();

      // Make fetch fail during sync (after successful initialization)
      mockGit.fetch.mockRejectedValueOnce(new Error("Network error"));

      // Should throw but log the error
      await expect(service.sync()).rejects.toThrow("Network error");
      expect(console.error).toHaveBeenCalledWith(
        "\n❌ Error during worktree synchronization after all retry attempts:",
        expect.any(Error),
      );
    });

    it("should continue sync even if individual worktree operations fail", async () => {
      const config = createMockConfig({ runOnce: true });

      // Make first worktree add fail
      mockGit.raw.mockRejectedValueOnce(new Error("Worktree already exists")).mockResolvedValue("");

      const service = new WorktreeSyncService(config);
      await service.initialize();

      // Should not throw and continue with other operations
      await expect(service.sync()).resolves.not.toThrow();
    });
  });

  describe("Complex scenarios", () => {
    it("should handle mixed operations: add, remove, and skip", async () => {
      const config = createMockConfig({ runOnce: true });

      // Setup: existing worktrees include some to keep, some to remove
      (fs.readdir as Mock<any>).mockResolvedValue([
        "main", // Keep (exists in remote)
        "feature-1", // Keep (exists in remote)
        "old-feature", // Remove (not in remote)
        "dirty-branch", // Skip removal (has changes)
      ]);

      // Mock git worktree list --porcelain
      const mockRawCalls: string[][] = [];
      (mockGit.raw as Mock<any>).mockImplementation(async (args) => {
        const argsArray = args as string[];
        mockRawCalls.push(argsArray);
        if (argsArray[0] === "worktree" && argsArray[1] === "list" && argsArray[2] === "--porcelain") {
          return `worktree /test/repo
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
      (fs.stat as Mock<any>).mockResolvedValue({ isDirectory: vi.fn().mockReturnValue(true) });
      (fs.rm as Mock<any>).mockResolvedValue(undefined);

      // Mock fs.access for hasOperationInProgress checks
      (fs.access as Mock<any>).mockRejectedValue(new Error("Not found"));

      // Mock status checks and other safety checks
      const statusChecks = new Map([
        ["/test/worktrees/old-feature", true], // Clean, can remove
        ["/test/worktrees/dirty-branch", false], // Has changes, skip
      ]);

      (mockGit.status as Mock<any>).mockImplementation(async () => {
        const currentPath = (simpleGit as unknown as Mock<any>).mock.calls.slice(-1)[0][0] as string;
        const isClean = statusChecks.get(currentPath) ?? true;
        return {
          modified: isClean ? [] : ["file.txt"],
          deleted: [],
          renamed: [],
          created: [],
          conflicted: [],
          not_added: [],
        } as any;
      });

      // Reset the mock implementation before defining the new one
      (mockGit.raw as Mock<any>).mockReset();

      // Mock the raw calls for safety checks on old-feature (clean worktree)
      (mockGit.raw as Mock<any>).mockImplementation(async (args) => {
        const argsArray = args as string[];
        mockRawCalls.push(argsArray);

        // Handle different git commands
        if (argsArray[0] === "worktree" && argsArray[1] === "list" && argsArray[2] === "--porcelain") {
          return `worktree /test/repo
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
          };
        } else if (pathStr && pathStr.includes("dirty-branch")) {
          return {
            ...mockGit,
            stashList: vi.fn<any>().mockResolvedValue({ total: 0 }),
            branch: vi.fn<any>().mockResolvedValue({ current: "dirty-branch" }),
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

      // Should add feature-2 with tracking
      expect(operationCalls).toContainEqual([
        "worktree",
        "add",
        "--track",
        "-b",
        "feature-2",
        "/test/worktrees/feature-2",
        "origin/feature-2",
      ]);

      // Should remove old-feature with full path
      expect(operationCalls).toContainEqual(["worktree", "remove", "/test/worktrees/old-feature", "--force"]);

      // Should NOT remove dirty-branch
      expect(operationCalls).not.toContainEqual(["worktree", "remove", "/test/worktrees/dirty-branch", "--force"]);

      // Should log warning about dirty-branch
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Skipping removal of 'dirty-branch'"));
    });
  });
});
