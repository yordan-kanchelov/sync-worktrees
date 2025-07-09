import * as fs from "fs/promises";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as cron from "node-cron";
import simpleGit from "simple-git";

import { WorktreeSyncService } from "../services/worktree-sync.service";

import { TEST_PATHS, createMockConfig } from "./test-utils";
// import { parseArguments } from '../utils/cli'; // Skip due to ESM issues

import type { SimpleGit } from "simple-git";

// Mock all external dependencies
jest.mock("fs/promises");
jest.mock("simple-git");
jest.mock("node-cron");
// jest.mock('../utils/cli'); // Skip due to ESM issues

describe("Integration Tests", () => {
  let mockGit: jest.Mocked<SimpleGit>;
  let mockScheduledTask: { start: jest.Mock; stop: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock git
    mockGit = {
      fetch: jest.fn<any>().mockResolvedValue(undefined),
      branch: jest.fn<any>().mockResolvedValue({
        all: ["origin/main", "origin/feature-1", "origin/feature-2"],
        current: "main",
      }),
      raw: jest.fn<any>().mockResolvedValue(""),
      status: jest.fn<any>().mockResolvedValue({
        isClean: jest.fn().mockReturnValue(true),
      }),
      clone: jest.fn<any>().mockResolvedValue(undefined),
      addConfig: jest.fn<any>().mockResolvedValue(undefined),
    } as any;

    (simpleGit as unknown as jest.Mock).mockReturnValue(mockGit);

    // Setup mock cron
    mockScheduledTask = {
      start: jest.fn(),
      stop: jest.fn(),
    };
    (cron.schedule as jest.Mock).mockReturnValue(mockScheduledTask);

    // Setup mock fs
    (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
    (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
    (fs.readdir as jest.Mock<any>).mockResolvedValue(["main"]);
  });

  describe("Full sync workflow", () => {
    it("should skip creating worktree for currently checked out branch", async () => {
      // Mock readdir to return empty (no existing worktrees)
      (fs.readdir as jest.Mock<any>).mockResolvedValueOnce([]);

      // Mock branch calls - first for remote branches, second for current branch
      mockGit.branch
        .mockResolvedValueOnce({
          all: ["origin/main", "origin/feature-1", "origin/feature-2"],
          current: "feature-1",
        } as any)
        .mockResolvedValueOnce({
          current: "feature-1",
        } as any);

      const config = createMockConfig({ runOnce: true });

      const service = new WorktreeSyncService(config);
      await service.initialize();
      await service.sync();

      // Should NOT create worktree for feature-1 (current branch)
      expect(mockGit.raw).not.toHaveBeenCalledWith([
        "worktree",
        "add",
        TEST_PATHS.worktree + "/feature-1",
        "feature-1",
      ]);

      // Should create worktrees for main and feature-2
      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", TEST_PATHS.worktree + "/main", "main"]);
      expect(mockGit.raw).toHaveBeenCalledWith(["worktree", "add", TEST_PATHS.worktree + "/feature-2", "feature-2"]);
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

      // Make fetch fail
      mockGit.fetch.mockRejectedValueOnce(new Error("Network error"));

      const service = new WorktreeSyncService(config);
      await service.initialize();

      // Should throw but log the error
      await expect(service.sync()).rejects.toThrow("Network error");
      expect(console.error).toHaveBeenCalledWith("Error during worktree synchronization:", expect.any(Error));
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
      (fs.readdir as jest.Mock<any>).mockResolvedValue([
        "main", // Keep (exists in remote)
        "feature-1", // Keep (exists in remote)
        "old-feature", // Remove (not in remote)
        "dirty-branch", // Skip removal (has changes)
      ]);

      // Mock git worktree list --porcelain
      const mockRawCalls: string[][] = [];
      (mockGit.raw as jest.Mock<any>).mockImplementation(async (args: string[]) => {
        mockRawCalls.push(args);
        if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
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
      (fs.stat as jest.Mock<any>).mockResolvedValue({ isDirectory: jest.fn().mockReturnValue(true) });
      (fs.rm as jest.Mock<any>).mockResolvedValue(undefined);

      // Mock status checks
      const statusChecks = new Map([
        ["/test/worktrees/old-feature", true], // Clean, can remove
        ["/test/worktrees/dirty-branch", false], // Has changes, skip
      ]);

      (mockGit.status as jest.Mock<any>).mockImplementation(async () => {
        const currentPath = (simpleGit as unknown as jest.Mock<any>).mock.calls.slice(-1)[0][0] as string;
        const isClean = statusChecks.get(currentPath) ?? true;
        return { isClean: jest.fn().mockReturnValue(isClean) } as any;
      });

      const service = new WorktreeSyncService(config);
      await service.initialize();
      await service.sync();

      // Filter out the worktree list calls
      const operationCalls = mockRawCalls.filter((args) => !(args[1] === "list" && args[2] === "--porcelain"));

      // Should add feature-2
      expect(operationCalls).toContainEqual(["worktree", "add", "/test/worktrees/feature-2", "feature-2"]);

      // Should remove old-feature with full path
      expect(operationCalls).toContainEqual(["worktree", "remove", "/test/worktrees/old-feature", "--force"]);

      // Should NOT remove dirty-branch
      expect(operationCalls).not.toContainEqual(["worktree", "remove", "/test/worktrees/dirty-branch", "--force"]);

      // Should log warning about dirty-branch
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Skipping removal of 'dirty-branch'"));
    });
  });
});
