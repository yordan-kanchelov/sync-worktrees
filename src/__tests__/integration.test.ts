import * as fs from "fs/promises";

import simpleGit from "simple-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorktreeSyncService } from "../services/worktree-sync.service";

import { TEST_PATHS, TEST_URLS, createMockConfig, createMockLogger, createRemoteRefListOutput } from "./test-utils";

import type { Logger } from "../services/logger.service";
import type { SimpleGit } from "simple-git";
import type { Mock, Mocked } from "vitest";

vi.mock("fs/promises");
vi.mock("simple-git");

describe("Integration Tests", () => {
  let mockGit: Mocked<SimpleGit>;
  let mockLogger: Logger;

  const REMOTE_BRANCHES = ["main", "feature-1", "feature-2"];

  const rawDefault = async (args: unknown): Promise<string> => {
    if (!Array.isArray(args)) return "";
    if (args[0] === "worktree" && args[1] === "list") {
      return `worktree ${TEST_PATHS.worktree}/main\nbranch refs/heads/main\n\n`;
    }
    if (args[0] === "for-each-ref") return createRemoteRefListOutput(REMOTE_BRANCHES);
    return "";
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();

    mockGit = {
      fetch: vi.fn<any>().mockResolvedValue(undefined),
      branch: vi.fn<any>().mockResolvedValue({
        all: REMOTE_BRANCHES.map((branch) => `origin/${branch}`),
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
      env: vi.fn<any>().mockReturnThis(),
    } as any;

    (simpleGit as unknown as Mock).mockReturnValue(mockGit);

    (fs.access as Mock<any>).mockResolvedValue(undefined);
    (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
    (fs.readdir as Mock<any>).mockImplementation(async (dirPath: unknown) =>
      String(dirPath).endsWith(".trash") ? [] : ["main"],
    );
    (fs.open as Mock<any>).mockResolvedValue({
      writeFile: vi.fn<any>().mockResolvedValue(undefined),
      appendFile: vi.fn<any>().mockResolvedValue(undefined),
      sync: vi.fn<any>().mockResolvedValue(undefined),
      close: vi.fn<any>().mockResolvedValue(undefined),
    });
  });

  describe("Full sync workflow", () => {
    it("should skip creating worktree for currently checked out branch", async () => {
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
        if (argsArray[3] === "remote.origin.url") return TEST_URLS.github;
        if (argsArray[0] === "config") throw new Error("config not found");
        if (argsArray[0] === "show-ref" && String(argsArray[argsArray.length - 1]).startsWith("refs/heads/")) {
          throw new Error("show-ref: not found");
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

      (mockGit.branch as Mock<any>).mockImplementation(async (args?: unknown) =>
        Array.isArray(args) && args[0] === "-r"
          ? ({ all: ["origin/main", "origin/feature-1", "origin/feature-2"], current: "" } as any)
          : ({ all: [], current: "main" } as any),
      );

      const config = createMockConfig({ runOnce: true, logger: mockLogger });

      const service = new WorktreeSyncService(config);
      await service.initialize();
      await service.sync();

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

      const worktreeAddCalls = mockGit.raw.mock.calls.filter(
        (call) => call[0][0] === "worktree" && call[0][1] === "add",
      );

      expect(worktreeAddCalls.length).toBeGreaterThanOrEqual(1);

      const createdBranches = worktreeAddCalls.map((call) => {
        return call[0][4];
      });

      expect(createdBranches).not.toContain("feature-1");

      if (!createdBranches.includes("feature-2")) {
        expect(createdBranches).toContain("main");
      }
    });
  });
  describe("Error handling", () => {
    it("should handle and recover from sync errors", async () => {
      const config = createMockConfig({ runOnce: true, logger: mockLogger });

      const service = new WorktreeSyncService(config);
      await service.initialize();

      mockGit.fetch.mockRejectedValueOnce(new Error("Network error"));

      await expect(service.sync()).rejects.toThrow("Network error");
      expect(mockLogger.error).toHaveBeenCalledWith(
        "\n❌ Error during worktree synchronization after all retry attempts:",
        expect.any(Error),
      );
    });

    it("should continue sync even if individual worktree operations fail", async () => {
      const config = createMockConfig({ runOnce: true, logger: mockLogger });

      (mockGit.raw as Mock<any>)
        .mockRejectedValueOnce(new Error("Worktree already exists"))
        .mockImplementation(rawDefault);

      const service = new WorktreeSyncService(config);
      await service.initialize();

      await expect(service.sync()).resolves.not.toThrow();
    });
  });

  describe("Complex scenarios", () => {
    it("should handle mixed operations: add, remove, and skip", async () => {
      const config = createMockConfig({ runOnce: true, logger: mockLogger, trash: { enabled: false } });

      (fs.readdir as Mock<any>).mockImplementation(async (dirPath: unknown) =>
        String(dirPath).endsWith(".trash") ? [] : ["main", "feature-1", "old-feature", "dirty-branch"],
      );

      const mockRawCalls: string[][] = [];
      (mockGit.raw as Mock<any>).mockImplementation(async (args) => {
        const argsArray = args as string[];
        mockRawCalls.push(argsArray);
        if (argsArray[0] === "for-each-ref") {
          return createRemoteRefListOutput(REMOTE_BRANCHES);
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
        }
        return "";
      });

      (fs.stat as Mock<any>).mockResolvedValue({
        isDirectory: vi.fn().mockReturnValue(true),
        isFile: vi.fn().mockReturnValue(false),
      });
      (fs.rm as Mock<any>).mockResolvedValue(undefined);

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
        files: [],
      };
      const dirtyStatus = { ...cleanStatus, modified: ["file.txt"] };

      (mockGit.raw as Mock<any>).mockReset();

      (mockGit.raw as Mock<any>).mockImplementation(async (args) => {
        const argsArray = args as string[];
        mockRawCalls.push(argsArray);

        if (argsArray[0] === "for-each-ref") {
          return createRemoteRefListOutput(REMOTE_BRANCHES);
        }

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
          return "0\n";
        } else if (argsArray[0] === "submodule" && argsArray[1] === "status") {
          return "";
        } else if (argsArray[0] === "worktree" && argsArray[1] === "add") {
          return "";
        } else if (argsArray[0] === "branch" && !argsArray[1]) {
          return { all: [], current: "main" };
        } else if (argsArray[0] === "worktree" && argsArray[1] === "remove") {
          return "";
        } else if (argsArray[0] === "worktree" && argsArray[1] === "prune") {
          return "";
        }

        return "";
      });

      (simpleGit as unknown as Mock).mockImplementation((workPath?: unknown) => {
        const pathStr = workPath as string;
        if (pathStr && pathStr.includes("old-feature")) {
          return {
            ...mockGit,
            stashList: vi.fn<any>().mockResolvedValue({ total: 0 }),
            branch: vi.fn<any>().mockResolvedValue({ current: "old-feature" }),
            status: vi.fn<any>().mockResolvedValue({ ...cleanStatus, current: "old-feature", detached: false }),
          };
        } else if (pathStr && pathStr.includes("dirty-branch")) {
          return {
            ...mockGit,
            stashList: vi.fn<any>().mockResolvedValue({ total: 0 }),
            branch: vi.fn<any>().mockResolvedValue({ current: "dirty-branch" }),
            status: vi.fn<any>().mockResolvedValue({ ...dirtyStatus, current: "dirty-branch", detached: false }),
          };
        } else if (pathStr && pathStr.includes(".bare")) {
          return {
            ...mockGit,
            branch: vi.fn<any>().mockResolvedValue({ all: [], current: "main" }),
          };
        }
        return mockGit;
      });

      (fs.lstat as Mock<any>).mockImplementation(async (target: unknown) => {
        if (target === "/test/worktrees/feature-2") {
          throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
        }
        return { isDirectory: () => true, isSymbolicLink: () => false };
      });

      const service = new WorktreeSyncService(config);
      await service.initialize();
      await service.sync();

      const operationCalls = mockRawCalls.filter((args) => !(args[1] === "list" && args[2] === "--porcelain"));

      expect(operationCalls).toContainEqual(
        expect.arrayContaining([
          "worktree",
          "add",
          "--track",
          "-b",
          "feature-2",
          "/test/worktrees/feature-2",
          "origin/feature-2",
        ]),
      );

      expect(operationCalls).toContainEqual(["worktree", "remove", "/test/worktrees/old-feature"]);

      expect(operationCalls).not.toContainEqual(["worktree", "remove", "/test/worktrees/dirty-branch"]);
      expect(operationCalls).not.toContainEqual(["worktree", "remove", "/test/worktrees/dirty-branch", "--force"]);

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Skipping removal of 'dirty-branch'"));
    });
  });
});
