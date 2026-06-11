import * as fs from "fs/promises";
import * as path from "path";

import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TEST_BRANCHES, createMockLogger } from "../../__tests__/test-utils";
import { ConfigError, WorktreeNotCleanError } from "../../errors";
import { GitMaintenanceService } from "../git-maintenance.service";
import { PathResolutionService } from "../path-resolution.service";
import { RepoOperationLock } from "../repo-operation-lock";
import { TrashMigrationService } from "../trash-migration.service";
import { TrashReaperService } from "../trash-reaper.service";
import { WorktreeSyncService } from "../worktree-sync.service";

const pathResolution = new PathResolutionService();
const wtPath = (dir: string, branch: string): string => pathResolution.getBranchWorktreePath(dir, branch);

import type { Config } from "../../types";
import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { Mock, Mocked } from "vitest";

// Use vi.hoisted to create mock instance that can be accessed in both factory and tests
const { mockGitServiceInstance } = vi.hoisted(() => {
  return {
    mockGitServiceInstance: {
      initialize: vi.fn<any>().mockResolvedValue(undefined),
      isInitialized: vi.fn().mockReturnValue(true),
      fetchAll: vi.fn<any>().mockResolvedValue(undefined),
      fetchBranch: vi.fn<any>().mockResolvedValue(undefined),
      getRemoteBranches: vi.fn<any>().mockResolvedValue(["main", "feature-1", "feature-2"]),
      addWorktree: vi.fn<any>().mockResolvedValue(undefined),
      removeWorktree: vi.fn<any>().mockResolvedValue(undefined),
      pruneWorktrees: vi.fn<any>().mockResolvedValue(undefined),
      checkWorktreeStatus: vi.fn<any>().mockResolvedValue(true),
      hasUnpushedCommits: vi.fn<any>().mockResolvedValue(false),
      hasUpstreamGone: vi.fn<any>().mockResolvedValue(false),
      hasStashedChanges: vi.fn<any>().mockResolvedValue(false),
      hasOperationInProgress: vi.fn<any>().mockResolvedValue(false),
      hasModifiedSubmodules: vi.fn<any>().mockResolvedValue(false),
      getFullWorktreeStatus: vi.fn<any>().mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        fullyPushedUpstreamDeleted: false,
        canRemove: true,
        reasons: [],
      }),
      getCurrentBranch: vi.fn<any>().mockResolvedValue("main"),
      getDefaultBranch: vi.fn().mockReturnValue("main"),
      getWorktrees: vi.fn<any>().mockResolvedValue([]),
      isWorktreeBehind: vi.fn<any>().mockResolvedValue(false),
      canFastForward: vi.fn<any>().mockResolvedValue(true),
      updateWorktree: vi.fn<any>().mockResolvedValue(undefined),
      getGit: vi.fn<any>(),
      setLfsSkipEnabled: vi.fn(),
      compareTreeContent: vi.fn<any>().mockResolvedValue(false),
      resetToUpstream: vi.fn<any>().mockResolvedValue(undefined),
      hasDivergedHistory: vi.fn<any>().mockResolvedValue(false),
      isLocalAheadOfRemote: vi.fn<any>().mockResolvedValue(false),
      getWorktreeMetadata: vi.fn<any>().mockResolvedValue(null),
      getCurrentCommit: vi.fn<any>().mockResolvedValue("abc123"),
      getRemoteCommit: vi.fn<any>().mockResolvedValue("def456"),
      getRemoteBranchesWithActivity: vi.fn<any>().mockResolvedValue([]),
      getRemoteBranchTips: vi.fn<any>().mockResolvedValue(new Map()),
      recordRemoteTip: vi.fn<any>().mockResolvedValue(undefined),
      checkoutHead: vi.fn<any>().mockResolvedValue(undefined),
      getSparseCheckoutService: vi.fn(),
      updateRef: vi.fn<any>().mockResolvedValue(undefined),
      deleteRef: vi.fn<any>().mockResolvedValue(undefined),
      listRefs: vi.fn<any>().mockResolvedValue([]),
      deleteLocalBranch: vi.fn<any>().mockResolvedValue(undefined),
      createBundleFromRef: vi.fn<any>().mockResolvedValue(true),
      setStaleDirectoryTrasher: vi.fn(),
    } as any,
  };
});

// Mock modules
vi.mock("fs/promises");
vi.mock("simple-git");
vi.mock("../git.service", () => ({
  GitService: vi.fn(function (this: any) {
    return mockGitServiceInstance;
  }),
}));

describe("WorktreeSyncService", () => {
  let service: WorktreeSyncService;
  let mockConfig: Config;
  let mockGitService: Mocked<GitService>;
  let mockLogger: Logger;
  // Audit records and trash manifests now go through fs.open + handle.writeFile/
  // appendFile + sync (durable writes), not fs.writeFile/appendFile. Recorded
  // here so tests can assert on what was written and where.
  let handleWrites: Array<{ path: string; content: string }>;

  const findLastManifestWrite = (): { path: string; content: string } | undefined =>
    [...handleWrites].reverse().find((write) => write.path.includes("manifest.json"));

  beforeEach(() => {
    vi.clearAllMocks();

    handleWrites = [];
    (fs.open as Mock<any>).mockImplementation(async (filePath: unknown) => ({
      writeFile: vi.fn(async (content: string) => {
        handleWrites.push({ path: String(filePath), content });
      }),
      appendFile: vi.fn(async (content: string) => {
        handleWrites.push({ path: String(filePath), content });
      }),
      sync: vi.fn<any>().mockResolvedValue(undefined),
      close: vi.fn<any>().mockResolvedValue(undefined),
    }));

    mockLogger = createMockLogger();

    mockConfig = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/test/worktrees",
      cronSchedule: "0 * * * *",
      runOnce: false,
      logger: mockLogger,
      // These suites assert the direct-delete mechanism; the trash pipeline
      // has its own suites (trash.service / trash-reaper / trash-migration).
      trash: { enabled: false },
    };

    // Reference the hoisted mock instance
    mockGitService = mockGitServiceInstance;

    const cloneGitClient = {
      raw: vi.fn(async (args: string[]) => {
        const key = args.join(" ");
        if (key === "remote get-url origin") return "https://github.com/test/repo.git";
        if (key === "rev-parse --abbrev-ref HEAD") return "main";
        return "";
      }),
      clone: vi.fn().mockResolvedValue(undefined),
      fetch: vi.fn().mockResolvedValue(undefined),
      merge: vi.fn().mockResolvedValue(undefined),
      env: vi.fn(),
    };
    cloneGitClient.env.mockReturnValue(cloneGitClient);
    (simpleGit as unknown as Mock).mockReturnValue(cloneGitClient);

    service = new WorktreeSyncService(mockConfig);
  });

  describe("initialize", () => {
    it("should initialize git service", async () => {
      mockGitService.isInitialized.mockReturnValueOnce(false);
      await service.initialize();

      expect(mockGitService.initialize).toHaveBeenCalled();
    });

    it("forwards clone-mode progress from CloneSyncService to registered listeners", async () => {
      const cloneConfig: Config = { ...mockConfig, mode: "clone", branch: "main" };
      const progressEvents: Array<{ phase: string; message: string }> = [];
      (fs.readdir as Mock<any>).mockResolvedValueOnce([".git"]);

      service = new WorktreeSyncService(cloneConfig);
      service.onProgress((event) => progressEvents.push(event));

      await service.initialize();

      expect(progressEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ phase: "initialize", message: "Initializing repository" }),
          expect.objectContaining({ phase: "branch", message: "Using configured branch 'main'" }),
          expect.objectContaining({
            phase: "clone",
            message: "Validating existing clone for 'https://github.com/test/repo.git'",
          }),
          expect.objectContaining({ phase: "initialize", message: "Repository initialized" }),
        ]),
      );
    });

    it("accumulates clone-mode skip reasons across init for retrieval after sync", async () => {
      const cloneConfig: Config = { ...mockConfig, mode: "clone", branch: "main" };
      const cloneGitClient = {
        raw: vi.fn(async (args: string[]) => {
          const key = args.join(" ");
          if (key === "remote get-url origin") return "https://github.com/test/repo.git";
          if (key === "rev-parse --abbrev-ref HEAD") return "develop";
          return "";
        }),
        clone: vi.fn().mockResolvedValue(undefined),
        fetch: vi.fn().mockResolvedValue(undefined),
        merge: vi.fn().mockResolvedValue(undefined),
        env: vi.fn(),
      };
      cloneGitClient.env.mockReturnValue(cloneGitClient);
      (simpleGit as unknown as Mock).mockReturnValue(cloneGitClient);
      (fs.readdir as Mock<any>).mockResolvedValueOnce([".git"]);

      service = new WorktreeSyncService(cloneConfig);
      await service.initialize();

      const skips = service.getRecordedSkips();
      expect(skips).toEqual([
        { kind: "branch_mismatch", phase: "init", currentBranch: "develop", expectedBranch: "main" },
      ]);

      service.clearRecordedSkips();
      expect(service.getRecordedSkips()).toEqual([]);
    });
  });

  describe("sync", () => {
    beforeEach(async () => {
      await service.initialize();

      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);

      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return [];
      });

      mockGitService.fetchAll.mockResolvedValue(undefined);
      mockGitService.getWorktrees.mockResolvedValue([]);
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-1", "feature-2"]);
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasUnpushedCommits.mockResolvedValue(false);
      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        fullyPushedUpstreamDeleted: false,
        canRemove: true,
        reasons: [],
      });
    });

    it("should complete full sync workflow successfully", async () => {
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["feature-1", "old-branch"];
      });

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/feature-1", branch: "feature-1" },
        { path: "/test/worktrees/old-branch", branch: "old-branch" },
      ]);

      const result = await service.sync();

      // Verify workflow steps
      expect(mockGitService.fetchAll).toHaveBeenCalled();
      expect(mockGitService.getRemoteBranches).toHaveBeenCalled();
      expect(mockGitService.getDefaultBranch).toHaveBeenCalled();
      expect(fs.mkdir).toHaveBeenCalledWith("/test/worktrees", { recursive: true });
      expect(mockGitService.getWorktrees).toHaveBeenCalled();

      // Should create new worktree for feature-2 (but not main, as it's the current branch)
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature-2", wtPath("/test/worktrees", "feature-2"));
      expect(mockGitService.addWorktree).not.toHaveBeenCalledWith("main", wtPath("/test/worktrees", "main"));

      // Should check and remove old-branch
      expect(mockGitService.getFullWorktreeStatus).toHaveBeenCalledWith(
        path.join("/test/worktrees", "old-branch"),
        undefined,
      );
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "old-branch"));

      // Should prune at the end
      expect(mockGitService.pruneWorktrees).toHaveBeenCalled();
      expect(result).toMatchObject({
        started: true,
        outcome: {
          mode: "worktree",
          counts: expect.objectContaining({ created: 1, removed: 1, noop: 1 }),
          actions: expect.arrayContaining([
            { kind: "created", branch: "feature-2", path: wtPath("/test/worktrees", "feature-2") },
            { kind: "removed", branch: "old-branch", path: path.join("/test/worktrees", "old-branch") },
          ]),
        },
      });
    });

    it("should handle empty remote branches", async () => {
      mockGitService.getRemoteBranches.mockResolvedValue([]);
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return [];
      });

      await service.sync();

      expect(mockGitService.addWorktree).not.toHaveBeenCalled();
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(mockGitService.pruneWorktrees).toHaveBeenCalled();
    });

    it.each([
      {
        scenario: "local changes",
        branch: "dirty-branch",
        status: {
          isClean: false,
          hasUnpushedCommits: false,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          fullyPushedUpstreamDeleted: false,
          canRemove: false,
          reasons: ["uncommitted changes"],
        },
      },
      {
        scenario: "unpushed commits",
        branch: "unpushed-branch",
        status: {
          isClean: true,
          hasUnpushedCommits: true,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          fullyPushedUpstreamDeleted: false,
          canRemove: false,
          reasons: ["unpushed commits"],
        },
      },
      {
        scenario: "both local changes and unpushed commits",
        branch: "dirty-unpushed-branch",
        status: {
          isClean: false,
          hasUnpushedCommits: true,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          fullyPushedUpstreamDeleted: false,
          canRemove: false,
          reasons: ["uncommitted changes", "unpushed commits"],
        },
      },
    ])("should skip worktrees with $scenario", async ({ branch, status }) => {
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return [branch];
      });
      mockGitService.getWorktrees.mockResolvedValue([{ path: `/test/worktrees/${branch}`, branch }]);
      mockGitService.getFullWorktreeStatus.mockResolvedValue(status);

      await service.sync();

      expect(mockGitService.getFullWorktreeStatus).toHaveBeenCalledWith(
        path.join("/test/worktrees", branch),
        undefined,
      );
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should show special message for worktrees with deleted upstream", async () => {
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["deleted-upstream-branch"];
      });
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/deleted-upstream-branch", branch: "deleted-upstream-branch" },
      ]);
      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: true,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: true,
        fullyPushedUpstreamDeleted: false,
        canRemove: false,
        reasons: ["unpushed commits"],
      });

      await service.sync();

      expect(mockGitService.getFullWorktreeStatus).toHaveBeenCalledWith(
        path.join("/test/worktrees", "deleted-upstream-branch"),
        undefined,
      );
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Cannot automatically remove 'deleted-upstream-branch' - upstream branch was deleted"),
      );
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Please review manually: cd"));
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("git worktree remove"));
    });

    it("should handle errors during sync but still cleanup", async () => {
      const error = new Error("Fetch failed");
      mockGitService.fetchAll.mockRejectedValue(error);

      await expect(service.sync()).rejects.toThrow("Fetch failed");

      expect(mockLogger.error).toHaveBeenCalledWith(
        "\n❌ Error during worktree synchronization after all retry attempts:",
        error,
      );
    });

    it("should not remove stale worktree when status check fails", async () => {
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["broken-branch"];
      });
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/broken-branch", branch: "broken-branch" },
      ]);
      mockGitService.getFullWorktreeStatus.mockRejectedValue(new Error("Status check failed"));

      await service.sync();

      expect(mockGitService.getFullWorktreeStatus).toHaveBeenCalledWith("/test/worktrees/broken-branch", undefined);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Error checking worktree"),
        expect.any(Error),
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Skipping removal"));
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(mockGitService.pruneWorktrees).toHaveBeenCalled();
    });

    it("should create multiple new worktrees", async () => {
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-1", "feature-2", "feature-3"]);
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return [];
      });

      await service.sync();

      // Should skip main (current branch) and create the other 3
      expect(mockGitService.addWorktree).toHaveBeenCalledTimes(3);
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature-1", wtPath("/test/worktrees", "feature-1"));
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature-2", wtPath("/test/worktrees", "feature-2"));
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature-3", wtPath("/test/worktrees", "feature-3"));
      expect(mockGitService.addWorktree).not.toHaveBeenCalledWith("main", wtPath("/test/worktrees", "main"));
    });

    it("should remove multiple stale worktrees", async () => {
      mockGitService.getRemoteBranches.mockResolvedValue(["main"]);
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["old-1", "old-2", "old-3"];
      });
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/old-1", branch: "old-1" },
        { path: "/test/worktrees/old-2", branch: "old-2" },
        { path: "/test/worktrees/old-3", branch: "old-3" },
      ]);

      await service.sync();

      expect(mockGitService.removeWorktree).toHaveBeenCalledTimes(3);
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "old-1"));
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "old-2"));
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "old-3"));
    });

    it("should only remove worktrees that are clean with no unpushed commits", async () => {
      mockGitService.getRemoteBranches.mockResolvedValue(["main"]);
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["deleted-clean", "deleted-dirty", "deleted-unpushed"];
      });
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/deleted-clean", branch: "deleted-clean" },
        { path: "/test/worktrees/deleted-dirty", branch: "deleted-dirty" },
        { path: "/test/worktrees/deleted-unpushed", branch: "deleted-unpushed" },
      ]);

      // Set up different conditions for each worktree
      mockGitService.getFullWorktreeStatus
        .mockResolvedValueOnce({
          isClean: true,
          hasUnpushedCommits: false,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          fullyPushedUpstreamDeleted: false,
          canRemove: true,
          reasons: [],
        }) // deleted-clean: can remove
        .mockResolvedValueOnce({
          isClean: false,
          hasUnpushedCommits: false,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          fullyPushedUpstreamDeleted: false,
          canRemove: false,
          reasons: ["uncommitted changes"],
        }) // deleted-dirty: has uncommitted changes
        .mockResolvedValueOnce({
          isClean: true,
          hasUnpushedCommits: true,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          fullyPushedUpstreamDeleted: false,
          canRemove: false,
          reasons: ["unpushed commits"],
        }) // deleted-unpushed: has unpushed commits
        .mockResolvedValueOnce({
          isClean: true,
          hasUnpushedCommits: false,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          fullyPushedUpstreamDeleted: false,
          canRemove: true,
          reasons: [],
        }); // deleted-clean: TOCTOU re-validation before removal

      await service.sync();

      // Should only remove the worktree that is both clean AND has no unpushed commits
      expect(mockGitService.removeWorktree).toHaveBeenCalledTimes(1);
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "deleted-clean"));
      expect(mockGitService.removeWorktree).not.toHaveBeenCalledWith(path.join("/test/worktrees", "deleted-dirty"));
      expect(mockGitService.removeWorktree).not.toHaveBeenCalledWith(path.join("/test/worktrees", "deleted-unpushed"));

      // Verify all safety checks were performed via getFullWorktreeStatus
      // 3 initial checks + 1 TOCTOU re-validation before removal
      expect(mockGitService.getFullWorktreeStatus).toHaveBeenCalledTimes(4);
    });

    it("keeps a fully-pushed worktree when trash is disabled — removal would be irreversible", async () => {
      mockGitService.getRemoteBranches.mockResolvedValue(["main"]);
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["squash-merged"];
      });
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/squash-merged", branch: "squash-merged" },
      ]);
      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: true,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        fullyPushedUpstreamDeleted: true,
        canRemove: true,
        reasons: [],
      });

      const result = await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        started: true,
        outcome: {
          actions: expect.arrayContaining([
            expect.objectContaining({
              kind: "skipped",
              reason: "fully_pushed_trash_disabled",
              branch: "squash-merged",
            }),
          ]),
        },
      });
    });

    it("records the upstream tip for every worktree whose remote branch still exists", async () => {
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-1"]);
      mockGitService.getRemoteBranchTips.mockResolvedValue(
        new Map([
          ["main", "tip-main"],
          ["feature-1", "tip-f1"],
        ]),
      );
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["main", "feature-1", "gone-branch"];
      });
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature-1", branch: "feature-1" },
        { path: "/test/worktrees/gone-branch", branch: "gone-branch" },
      ]);

      await service.sync();

      expect(mockGitService.recordRemoteTip).toHaveBeenCalledWith("/test/worktrees/main", "main", "tip-main");
      expect(mockGitService.recordRemoteTip).toHaveBeenCalledWith("/test/worktrees/feature-1", "feature-1", "tip-f1");
      // Recording must never run for a branch whose remote ref is already gone —
      // it would overwrite the proof with nothing.
      expect(mockGitService.recordRemoteTip).not.toHaveBeenCalledWith(
        "/test/worktrees/gone-branch",
        expect.anything(),
        expect.anything(),
      );
    });

    it("should clean up orphaned directories that are not Git worktrees", async () => {
      // Mock file system with directories that don't match Git worktrees
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["feature-1", "orphaned-dir", "another-orphan"];
      });

      // Mock Git worktrees - only feature-1 is a valid worktree
      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/feature-1", branch: "feature-1" }]);

      // Mock fs.stat to return directory info
      const mockStat = { isDirectory: vi.fn().mockReturnValue(true) };
      (fs.stat as Mock<any>).mockResolvedValue(mockStat);

      // Orphans contain no .git, so deletion is allowed
      (fs.access as Mock<any>).mockImplementation(async (target: unknown) => {
        if ((target as string).endsWith(`${path.sep}.git`)) {
          throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
        }
        return undefined;
      });

      // Mock fs.rm
      (fs.rm as Mock<any>).mockResolvedValue(undefined);

      await service.sync();

      // Should remove orphaned directories
      expect(fs.rm).toHaveBeenCalledTimes(2);
      expect(fs.rm).toHaveBeenCalledWith(path.join("/test/worktrees", "orphaned-dir"), {
        recursive: true,
        force: true,
      });
      expect(fs.rm).toHaveBeenCalledWith(path.join("/test/worktrees", "another-orphan"), {
        recursive: true,
        force: true,
      });

      // Should not remove valid worktree directory
      expect(fs.rm).not.toHaveBeenCalledWith(path.join("/test/worktrees", "feature-1"), expect.any(Object));
    });

    it("should handle errors during orphaned directory cleanup gracefully", async () => {
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["feature-1", "orphaned-dir"];
      });
      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/feature-1", branch: "feature-1" }]);

      const mockStat = { isDirectory: vi.fn().mockReturnValue(true) };
      (fs.stat as Mock<any>).mockResolvedValue(mockStat);

      (fs.access as Mock<any>).mockImplementation(async (target: unknown) => {
        if ((target as string).endsWith(`${path.sep}.git`)) {
          throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
        }
        return undefined;
      });

      // Mock fs.rm to throw an error
      (fs.rm as Mock<any>).mockRejectedValue(new Error("Permission denied"));

      await service.sync();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to remove orphaned directory"),
        expect.any(Error),
      );

      expect(mockGitService.pruneWorktrees).toHaveBeenCalled();
    });

    it("should handle errors when reading worktree directory", async () => {
      // Mock fs.readdir to throw an error
      (fs.readdir as Mock<any>).mockRejectedValue(new Error("Permission denied"));

      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/feature-1", branch: "feature-1" }]);

      await service.sync();

      expect(mockLogger.error).toHaveBeenCalledWith("Error during orphaned directory cleanup:", expect.any(Error));

      expect(mockGitService.pruneWorktrees).toHaveBeenCalled();
    });

    // Removal-safety regression tests: orphan cleanup must never
    // destroy a directory that may be a live checkout, and removals must leave
    // a persistent audit trail.
    describe("orphaned directory removal safety", () => {
      const orphanPath = path.join("/test/worktrees", "live-checkout");
      const errnoError = (code: string): NodeJS.ErrnoException =>
        Object.assign(new Error(`${code}: probe failed`), { code });

      afterEach(() => {
        mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-1", "feature-2"]);
        mockGitService.getWorktrees.mockResolvedValue([]);
        (fs.access as Mock<any>).mockReset();
      });

      const setupOrphan = (gitProbe: "exists" | "missing" | "unknown"): void => {
        (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
          if ((dirPath as string).endsWith(".diverged")) {
            throw errnoError("ENOENT");
          }
          return ["live-checkout"];
        });
        mockGitService.getWorktrees.mockResolvedValue([]);
        mockGitService.getRemoteBranches.mockResolvedValue([]);
        (fs.stat as Mock<any>).mockResolvedValue({ isDirectory: vi.fn().mockReturnValue(true) });
        (fs.rm as Mock<any>).mockResolvedValue(undefined);
        (fs.rename as Mock<any>).mockResolvedValue(undefined);
        (fs.access as Mock<any>).mockImplementation(async (target: unknown) => {
          if (target === path.join(orphanPath, ".git")) {
            if (gitProbe === "exists") return undefined;
            throw errnoError(gitProbe === "missing" ? "ENOENT" : "EMFILE");
          }
          return undefined;
        });
      };

      it("quarantines an orphaned directory containing a git checkout instead of deleting it", async () => {
        setupOrphan("exists");

        await service.sync();

        expect(fs.rm).not.toHaveBeenCalledWith(orphanPath, expect.anything());
        expect(fs.rename).toHaveBeenCalledWith(orphanPath, expect.stringContaining(".removed"));
      });

      it("skips orphan deletion when the .git probe fails for unknown reasons", async () => {
        setupOrphan("unknown");

        await service.sync();

        expect(fs.rm).not.toHaveBeenCalledWith(orphanPath, expect.anything());
        expect(fs.rename).not.toHaveBeenCalledWith(orphanPath, expect.anything());
      });

      it("still deletes an orphaned directory without a git checkout", async () => {
        setupOrphan("missing");

        await service.sync();

        expect(fs.rm).toHaveBeenCalledWith(orphanPath, { recursive: true, force: true });
      });
    });

    describe("removal audit log", () => {
      afterEach(() => {
        mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-1", "feature-2"]);
        mockGitService.getWorktrees.mockResolvedValue([]);
        mockGitService.removeWorktree.mockResolvedValue(undefined);
      });

      const setupStaleWorktree = (): void => {
        (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
          if ((dirPath as string).endsWith(".diverged")) {
            const error: any = new Error("ENOENT: no such file or directory");
            error.code = "ENOENT";
            throw error;
          }
          return ["old-branch"];
        });
        mockGitService.getWorktrees.mockResolvedValue([
          { path: path.join("/test/worktrees", "old-branch"), branch: "old-branch" },
        ]);
        mockGitService.getRemoteBranches.mockResolvedValue(["main"]);
      };

      it("appends an audit record before removing a pruned worktree", async () => {
        setupStaleWorktree();

        await service.sync();

        expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "old-branch"));
        // The "attempt" record must be opened and flushed before the data is gone.
        expect(fs.open).toHaveBeenCalledWith(expect.stringContaining("removals"), "a");
        expect(
          handleWrites.find((write) => write.path.includes("removals") && write.content.includes("old-branch")),
        ).toBeDefined();
        const auditOrder = (fs.open as Mock<any>).mock.invocationCallOrder[0];
        const removeOrder = (mockGitService.removeWorktree as Mock<any>).mock.invocationCallOrder[0];
        expect(auditOrder).toBeLessThan(removeOrder);
      });

      it("does not remove the worktree when the audit record cannot be written", async () => {
        setupStaleWorktree();
        (fs.open as Mock<any>).mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));

        await service.sync();

        expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      });

      it("treats git's refusal of a non-forced removal as a skip, not a failure", async () => {
        setupStaleWorktree();
        mockGitService.removeWorktree.mockRejectedValue(
          new WorktreeNotCleanError(path.join("/test/worktrees", "old-branch"), ["contains modified files"]),
        );

        const result = await service.sync();

        expect(result).toMatchObject({
          started: true,
          outcome: { counts: expect.objectContaining({ removed: 0, failed: 0 }) },
        });
      });
    });

    describe("branches with slashes in names", () => {
      it("should handle feature branches with slashes correctly", async () => {
        const remoteBranchesWithSlashes = [TEST_BRANCHES.main, "feat/LCR-8879", "feat/PHX-3198", TEST_BRANCHES.bugfix];
        mockGitService.getRemoteBranches.mockResolvedValue(remoteBranchesWithSlashes);
        mockGitService.getCurrentBranch.mockResolvedValue(TEST_BRANCHES.main);

        // First sync - create worktrees
        (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
          if ((dirPath as string).endsWith(".diverged")) {
            const error: any = new Error("ENOENT: no such file or directory");
            error.code = "ENOENT";
            throw error;
          }
          return [];
        });
        mockGitService.getWorktrees.mockResolvedValue([]);

        await service.sync();

        // Slash branches are flattened to sanitized names to avoid nested-path collisions
        expect(mockGitService.addWorktree).toHaveBeenCalledWith(
          "feat/LCR-8879",
          wtPath("/test/worktrees", "feat/LCR-8879"),
        );
        expect(mockGitService.addWorktree).toHaveBeenCalledWith(
          "feat/PHX-3198",
          wtPath("/test/worktrees", "feat/PHX-3198"),
        );
        expect(mockGitService.addWorktree).toHaveBeenCalledWith(
          "bugfix/issue-123",
          wtPath("/test/worktrees", "bugfix/issue-123"),
        );
      });

      it("should not treat parent directories of slash branches as orphaned", async () => {
        mockGitService.getRemoteBranches.mockResolvedValue(["main", "feat/LCR-8879", "feat/PHX-3198"]);
        mockGitService.getCurrentBranch.mockResolvedValue("main");

        // Mock file system showing nested structure
        (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
          if ((dirPath as string).endsWith(".diverged")) {
            const error: any = new Error("ENOENT: no such file or directory");
            error.code = "ENOENT";
            throw error;
          }
          return ["feat"]; // Parent directory
        });

        // Mock Git worktrees with nested paths
        mockGitService.getWorktrees.mockResolvedValue([
          { path: "/test/worktrees/feat/LCR-8879", branch: "feat/LCR-8879" },
          { path: "/test/worktrees/feat/PHX-3198", branch: "feat/PHX-3198" },
        ]);

        // Mock fs.stat to identify 'feat' as a directory
        const mockStat = { isDirectory: vi.fn().mockReturnValue(true) };
        (fs.stat as Mock<any>).mockResolvedValue(mockStat);
        (fs.rm as Mock<any>).mockResolvedValue(undefined);

        await service.sync();

        expect(fs.rm).not.toHaveBeenCalled();
        expect(mockLogger.info).not.toHaveBeenCalledWith(expect.stringContaining("Removed orphaned directory: feat"));
      });

      it("should remove slash-named worktrees correctly when branch is deleted", async () => {
        mockGitService.getRemoteBranches.mockResolvedValue(["main"]); // feat branches deleted from remote
        mockGitService.getCurrentBranch.mockResolvedValue("main");

        (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
          if ((dirPath as string).endsWith(".diverged")) {
            const error: any = new Error("ENOENT: no such file or directory");
            error.code = "ENOENT";
            throw error;
          }
          return ["feat"];
        });
        mockGitService.getWorktrees.mockResolvedValue([
          { path: "/test/worktrees/feat/LCR-8879", branch: "feat/LCR-8879" },
          { path: "/test/worktrees/feat/PHX-3198", branch: "feat/PHX-3198" },
        ]);

        await service.sync();

        // Should remove both worktrees with their full paths
        expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "feat/LCR-8879"));
        expect(mockGitService.removeWorktree).toHaveBeenCalledWith(path.join("/test/worktrees", "feat/PHX-3198"));
      });

      it("should handle mixed flat and nested worktree structures", async () => {
        mockGitService.getRemoteBranches.mockResolvedValue(["main", "simple-branch", "feat/nested-branch"]);
        mockGitService.getCurrentBranch.mockResolvedValue("main");

        // Mock mixed directory structure
        (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
          if ((dirPath as string).endsWith(".diverged")) {
            const error: any = new Error("ENOENT: no such file or directory");
            error.code = "ENOENT";
            throw error;
          }
          return ["simple-branch", "feat", "orphaned-dir"];
        });

        mockGitService.getWorktrees.mockResolvedValue([
          { path: "/test/worktrees/simple-branch", branch: "simple-branch" },
          { path: "/test/worktrees/feat/nested-branch", branch: "feat/nested-branch" },
        ]);

        const mockStat = { isDirectory: vi.fn().mockReturnValue(true) };
        (fs.stat as Mock<any>).mockResolvedValue(mockStat);
        (fs.access as Mock<any>).mockImplementation(async (target: unknown) => {
          if ((target as string).endsWith(`${path.sep}.git`)) {
            throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
          }
          return undefined;
        });
        (fs.rm as Mock<any>).mockResolvedValue(undefined);

        await service.sync();

        // Should only remove truly orphaned directory
        expect(fs.rm).toHaveBeenCalledTimes(1);
        expect(fs.rm).toHaveBeenCalledWith(path.join("/test/worktrees", "orphaned-dir"), {
          recursive: true,
          force: true,
        });
        expect(fs.rm).not.toHaveBeenCalledWith(path.join("/test/worktrees", "feat"), expect.any(Object));
      });
    });

    describe("LFS error handling", () => {
      it("should call setLfsSkipEnabled when falling back to branch-by-branch fetch", async () => {
        mockGitService.fetchAll = vi.fn<any>().mockRejectedValue(new Error("smudge filter lfs failed")) as any;
        mockGitService.fetchBranch = vi.fn<any>().mockResolvedValue(undefined) as any;

        await service.sync();

        expect(mockGitService.fetchBranch).toHaveBeenCalled();
        expect(mockGitService.setLfsSkipEnabled).toHaveBeenCalledWith(true);
        // Should be reset after sync completes
        expect(mockGitService.setLfsSkipEnabled).toHaveBeenCalledWith(false);
      });

      it("should handle partial LFS branch-by-branch fetch failures gracefully", async () => {
        mockGitService.fetchAll = vi.fn<any>().mockRejectedValue(new Error("smudge filter lfs failed")) as any;

        // Some branches succeed, some fail
        mockGitService.fetchBranch = vi.fn<any>().mockImplementation((...args: unknown[]) => {
          const branch = args[0] as string;
          if (branch === "feature-1") {
            return Promise.reject(new Error("LFS error on feature-1"));
          }
          return Promise.resolve(undefined);
        }) as any;

        mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-1", "feature-2"]);

        await service.sync();

        // All branches should have been attempted
        expect(mockGitService.fetchBranch).toHaveBeenCalledWith("main");
        expect(mockGitService.fetchBranch).toHaveBeenCalledWith("feature-1");
        expect(mockGitService.fetchBranch).toHaveBeenCalledWith("feature-2");

        // Should log about partial success
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("2/3 successful"));
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Failed to fetch 1 branches"));
      });

      it("should not retry LFS branch-by-branch if skipLfs is already configured", async () => {
        // Configure to skip LFS from the start
        mockConfig.skipLfs = true;
        service = new WorktreeSyncService(mockConfig);
        service["gitService"] = mockGitService;

        // Mock fetchAll to fail with LFS error
        mockGitService.fetchAll = vi.fn<any>().mockRejectedValue(new Error("smudge filter lfs failed")) as any;

        await expect(service.sync()).rejects.toThrow("LFS error retry limit exceeded");

        // Should not attempt branch-by-branch fetch when skipLfs is true
        expect(mockGitService.fetchBranch).not.toHaveBeenCalled();
      });
    });

    it("should not update worktrees when updateExistingWorktrees is disabled", async () => {
      // Disable update functionality
      mockConfig.updateExistingWorktrees = false;
      service = new WorktreeSyncService(mockConfig);

      // Mock worktrees that exist both locally and remotely
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-1"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature-1", branch: "feature-1" },
      ]);

      // These should not be called when updates are disabled
      mockGitService.isWorktreeBehind.mockResolvedValue(true);

      await service.sync();

      // Verify update checks were not performed
      expect(mockGitService.isWorktreeBehind).not.toHaveBeenCalled();
      expect(mockGitService.updateWorktree).not.toHaveBeenCalled();
    });

    it("should update worktrees that are behind when updateExistingWorktrees is enabled", async () => {
      // Mock worktrees that exist both locally and remotely
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-1", "feature-2"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature-1", branch: "feature-1" },
        { path: "/test/worktrees/feature-2", branch: "feature-2" },
      ]);

      // Mock fs.readdir to handle .diverged directory
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["main", "feature-1", "feature-2"];
      });

      // Mock different conditions
      mockGitService.hasOperationInProgress.mockResolvedValue(false); // No operations in progress

      mockGitService.checkWorktreeStatus
        .mockResolvedValueOnce(true) // main: clean
        .mockResolvedValueOnce(false) // feature-1: has local changes
        .mockResolvedValueOnce(true); // feature-2: clean

      mockGitService.canFastForward.mockResolvedValue(true); // All can fast-forward

      mockGitService.isWorktreeBehind
        .mockResolvedValueOnce(false) // main: up to date
        .mockResolvedValueOnce(true); // feature-2: behind

      await service.sync();

      // Should only check behind status for clean worktrees
      expect(mockGitService.isWorktreeBehind).toHaveBeenCalledTimes(2); // Only for clean worktrees

      // Should only update feature-2 (clean and behind)
      expect(mockGitService.updateWorktree).toHaveBeenCalledTimes(1);
      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/feature-2");
    });

    // Default-on trash: removals must move data into .trash/ instead of
    // deleting, and a trash failure must leave the worktree in place.
    describe("trash-enabled removal pipeline", () => {
      const oldBranchPath = path.join("/test/worktrees", "old-branch");

      beforeEach(() => {
        service = new WorktreeSyncService({ ...mockConfig, trash: undefined });

        (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
          if (!(dirPath as string).endsWith("worktrees")) {
            const error: any = new Error("ENOENT: no such file or directory");
            error.code = "ENOENT";
            throw error;
          }
          return ["old-branch"];
        });
        (fs.rename as Mock<any>).mockResolvedValue(undefined);
        (fs.writeFile as Mock<any>).mockResolvedValue(undefined);
        (fs.appendFile as Mock<any>).mockResolvedValue(undefined);

        mockGitService.getRemoteBranches.mockResolvedValue(["main"]);
        mockGitService.getWorktrees.mockResolvedValue([{ path: oldBranchPath, branch: "old-branch" }]);
      });

      it("prunes by moving the worktree into .trash/, clearing registration, and deleting the branch ref", async () => {
        await service.sync();

        expect(fs.rename).toHaveBeenCalledWith(oldBranchPath, expect.stringContaining(path.join(".trash", "")));
        expect(mockGitService.removeWorktree).toHaveBeenCalledWith(oldBranchPath, { force: true });
        expect(mockGitService.deleteLocalBranch).toHaveBeenCalledWith("old-branch");
        expect(mockGitService.updateRef).toHaveBeenCalledWith(
          expect.stringContaining("refs/sync-worktrees/trash/"),
          "abc123",
        );
      });

      it("records the prune as removed with a warning when the branch ref cannot be deleted — payload already safe", async () => {
        mockGitService.deleteLocalBranch.mockRejectedValueOnce(new Error("ref locked"));

        const result = await service.sync();

        expect(mockGitService.removeWorktree).toHaveBeenCalledWith(oldBranchPath, { force: true });
        expect(result).toMatchObject({
          started: true,
          outcome: {
            counts: expect.objectContaining({ removed: 1, failed: 0 }),
            actions: expect.arrayContaining([
              expect.objectContaining({
                kind: "removed",
                branch: "old-branch",
                warning: expect.stringContaining("leftover_branch_ref"),
              }),
            ]),
          },
        });
      });

      it("skips the removal entirely when the move to trash fails — fail closed, worktree stays", async () => {
        (fs.rename as Mock<any>).mockImplementation(async (...args: unknown[]) => {
          if ((args[1] as string).endsWith("payload")) {
            throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
          }
        });

        const result = await service.sync();

        expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          started: true,
          outcome: {
            counts: expect.objectContaining({ removed: 0 }),
            actions: expect.arrayContaining([
              expect.objectContaining({ kind: "skipped", reason: "trash_failed", branch: "old-branch" }),
            ]),
          },
        });
      });

      it("trashes a fully-pushed worktree with keepPinOnReap so its commits survive trash expiry", async () => {
        mockGitService.getFullWorktreeStatus.mockResolvedValue({
          isClean: true,
          hasUnpushedCommits: true,
          hasStashedChanges: false,
          hasOperationInProgress: false,
          hasModifiedSubmodules: false,
          upstreamGone: false,
          fullyPushedUpstreamDeleted: true,
          canRemove: true,
          reasons: [],
        });

        await service.sync();

        expect(fs.rename).toHaveBeenCalledWith(oldBranchPath, expect.stringContaining(".trash"));
        // The final manifest (the placeholder is written first with pinRef/bundleFile
        // null) must carry the pin and the self-contained bundle backup.
        const manifestWrite = findLastManifestWrite();
        expect(manifestWrite).toBeDefined();
        expect(JSON.parse(manifestWrite!.content)).toMatchObject({
          branch: "old-branch",
          keepPinOnReap: true,
          pinRef: expect.stringContaining("refs/sync-worktrees/trash/"),
          bundleFile: "commits.bundle",
        });
        expect(mockGitService.createBundleFromRef).toHaveBeenCalledWith(
          expect.stringContaining("commits.bundle"),
          expect.stringContaining("refs/sync-worktrees/trash/"),
        );
      });

      it("ordinary prunes do not set keepPinOnReap", async () => {
        await service.sync();

        const manifestWrite = findLastManifestWrite();
        expect(manifestWrite).toBeDefined();
        expect(JSON.parse(manifestWrite!.content)).toMatchObject({ keepPinOnReap: false });
        expect(mockGitService.createBundleFromRef).not.toHaveBeenCalled();
      });

      it("clears a dangling registration with a targeted remove when the directory is already gone — no trash attempt", async () => {
        // A previous removal moved the directory away but failed to clear the
        // registration; re-trashing the missing path would ENOENT into a
        // trash_failed skip on every tick forever. Must be a targeted
        // `worktree remove --force`, not a global prune — prune would also drop
        // unrelated registrations whose dirs sit on an unavailable mount.
        (fs.access as Mock<any>).mockImplementation(async (target: unknown) => {
          if (target === oldBranchPath) {
            throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
          }
          return undefined;
        });

        const result = await service.sync();

        expect(fs.rename).not.toHaveBeenCalledWith(oldBranchPath, expect.anything());
        expect(mockGitService.removeWorktree).toHaveBeenCalledWith(oldBranchPath, { force: true });
        expect(result).toMatchObject({
          started: true,
          outcome: {
            counts: expect.objectContaining({ removed: 1, failed: 0 }),
            actions: expect.arrayContaining([
              expect.objectContaining({ kind: "removed", branch: "old-branch", path: oldBranchPath }),
            ]),
          },
        });
        expect((result as { outcome: { actions: unknown[] } }).outcome.actions).not.toContainEqual(
          expect.objectContaining({ kind: "skipped", reason: "trash_failed" }),
        );
      });

      it("moves orphaned directories to trash instead of rm -rf", async () => {
        (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
          if (!(dirPath as string).endsWith("worktrees")) {
            const error: any = new Error("ENOENT: no such file or directory");
            error.code = "ENOENT";
            throw error;
          }
          return ["orphan-dir"];
        });
        (fs.stat as Mock<any>).mockResolvedValue({ isDirectory: () => true, isFile: () => false });
        (fs.access as Mock<any>).mockImplementation(async (p: unknown) => {
          if ((p as string).endsWith(`${path.sep}.git`)) {
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          }
        });
        mockGitService.getRemoteBranches.mockResolvedValue(["main"]);
        mockGitService.getWorktrees.mockResolvedValue([]);

        await service.sync();

        const orphanPath = path.join("/test/worktrees", "orphan-dir");
        expect(fs.rename).toHaveBeenCalledWith(orphanPath, expect.stringContaining(".trash"));
        expect(fs.rm).not.toHaveBeenCalledWith(orphanPath, expect.anything());
      });
    });
  });

  describe("trash maintenance wiring", () => {
    let migrationSpy: ReturnType<typeof vi.spyOn>;
    let reaperSpy: ReturnType<typeof vi.spyOn>;
    let prevNodeEnv: string | undefined;

    beforeEach(() => {
      prevNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      vi.spyOn(RepoOperationLock.prototype, "acquire").mockResolvedValue(async () => {});
      vi.spyOn(GitMaintenanceService.prototype, "runIfDueUnlocked").mockResolvedValue(undefined);
      migrationSpy = vi.spyOn(TrashMigrationService.prototype, "migrateLegacyUnlocked").mockResolvedValue(undefined);
      reaperSpy = vi.spyOn(TrashReaperService.prototype, "reapExpiredUnlocked").mockResolvedValue(undefined);
    });

    afterEach(() => {
      process.env.NODE_ENV = prevNodeEnv;
      vi.restoreAllMocks();
    });

    it("adopts legacy backups and reaps expired trash after a successful sync", async () => {
      const svc = new WorktreeSyncService(mockConfig);
      await svc.sync();
      expect(migrationSpy).toHaveBeenCalledTimes(1);
      expect(reaperSpy).toHaveBeenCalledTimes(1);
    });

    it("runs trash maintenance even when the sync fails", async () => {
      // Migration and reaping only act on local expiry state: a persistently
      // failing fetch must not let .trash/ grow without bound.
      mockGitService.fetchAll.mockRejectedValue(new Error("Fetch failed"));
      const svc = new WorktreeSyncService(mockConfig);
      await expect(svc.sync()).rejects.toThrow("Fetch failed");
      expect(migrationSpy).toHaveBeenCalledTimes(1);
      expect(reaperSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("handleDivergedBranch", () => {
    beforeEach(async () => {
      await service.initialize();

      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as Mock<any>).mockResolvedValue(undefined);

      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return ["feature-1"];
      });

      mockGitService.fetchAll.mockResolvedValue(undefined);
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-1"]);
      mockGitService.getWorktrees.mockResolvedValue([{ path: "/test/worktrees/feature-1", branch: "feature-1" }]);
      // The diverged-replace flow depends on these succeeding; re-stub them so
      // rejections configured by earlier suites cannot leak in.
      mockGitService.updateRef.mockResolvedValue(undefined);
      mockGitService.deleteLocalBranch.mockResolvedValue(undefined);
    });

    it("should reset to upstream when trees are identical (rebase with same content)", async () => {
      mockGitService.canFastForward.mockResolvedValue(false);
      mockGitService.isLocalAheadOfRemote.mockResolvedValue(false);
      mockGitService.compareTreeContent.mockResolvedValue(true);
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasOperationInProgress.mockResolvedValue(false);

      await service.sync();

      expect(mockGitService.compareTreeContent).toHaveBeenCalledWith("/test/worktrees/feature-1", "feature-1");
      expect(mockGitService.resetToUpstream).toHaveBeenCalledWith("/test/worktrees/feature-1", "feature-1");
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should reset to upstream when trees differ but no local changes since last sync", async () => {
      mockGitService.canFastForward.mockResolvedValue(false);
      mockGitService.isLocalAheadOfRemote.mockResolvedValue(false);
      mockGitService.compareTreeContent.mockResolvedValue(false);
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasOperationInProgress.mockResolvedValue(false);
      mockGitService.getWorktreeMetadata.mockResolvedValue({
        lastSyncCommit: "abc123",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/feature-1",
        createdFrom: { branch: "main", commit: "abc123" },
        syncHistory: [],
      });
      mockGitService.getCurrentCommit.mockResolvedValue("abc123");

      await service.sync();

      expect(mockGitService.resetToUpstream).toHaveBeenCalledWith("/test/worktrees/feature-1", "feature-1");
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should move to .diverged and recreate when trees differ and local changes exist", async () => {
      mockGitService.canFastForward.mockResolvedValue(false);
      mockGitService.isLocalAheadOfRemote.mockResolvedValue(false);
      mockGitService.compareTreeContent.mockResolvedValue(false);
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasOperationInProgress.mockResolvedValue(false);
      mockGitService.getWorktreeMetadata.mockResolvedValue({
        lastSyncCommit: "old-commit",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/feature-1",
        createdFrom: { branch: "main", commit: "old-commit" },
        syncHistory: [],
      });
      mockGitService.getCurrentCommit.mockResolvedValue("new-local-commit");
      mockGitService.getRemoteCommit.mockResolvedValue("remote-commit");

      (fs.rename as Mock<any>).mockResolvedValue(undefined);

      await service.sync();

      expect(fs.rename).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining(".diverged-info.json"), expect.any(String));
      // force is safe: the directory was already moved to .diverged/
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith("/test/worktrees/feature-1", { force: true });
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature-1", "/test/worktrees/feature-1");
    });

    it("should use copy+remove fallback when rename fails with EXDEV", async () => {
      mockGitService.canFastForward.mockResolvedValue(false);
      mockGitService.isLocalAheadOfRemote.mockResolvedValue(false);
      mockGitService.compareTreeContent.mockResolvedValue(false);
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasOperationInProgress.mockResolvedValue(false);
      mockGitService.getWorktreeMetadata.mockResolvedValue({
        lastSyncCommit: "old-commit",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/feature-1",
        createdFrom: { branch: "main", commit: "old-commit" },
        syncHistory: [],
      });
      mockGitService.getCurrentCommit.mockResolvedValue("new-local-commit");
      mockGitService.getRemoteCommit.mockResolvedValue("remote-commit");

      (fs.rename as Mock<any>).mockRejectedValue(
        Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }),
      );
      (fs.cp as Mock<any>).mockResolvedValue(undefined);
      (fs.rm as Mock<any>).mockResolvedValue(undefined);

      await service.sync();

      expect(fs.cp).toHaveBeenCalledWith("/test/worktrees/feature-1", expect.stringContaining(".diverged"), {
        recursive: true,
      });
      expect(fs.rm).toHaveBeenCalledWith("/test/worktrees/feature-1", { recursive: true, force: true });
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith("/test/worktrees/feature-1", { force: true });
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature-1", "/test/worktrees/feature-1");
    });

    it("with trash disabled, pins a keep ref before the move and deletes the local branch before recreating", async () => {
      mockGitService.canFastForward.mockResolvedValue(false);
      mockGitService.isLocalAheadOfRemote.mockResolvedValue(false);
      mockGitService.compareTreeContent.mockResolvedValue(false);
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasOperationInProgress.mockResolvedValue(false);
      mockGitService.getWorktreeMetadata.mockResolvedValue({
        lastSyncCommit: "old-commit",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/feature-1",
        createdFrom: { branch: "main", commit: "old-commit" },
        syncHistory: [],
      });
      mockGitService.getCurrentCommit.mockResolvedValue("new-local-commit");
      mockGitService.getRemoteCommit.mockResolvedValue("remote-commit");

      (fs.rename as Mock<any>).mockResolvedValue(undefined);

      await service.sync();

      // Without trash there is no pin ref, so the keep ref is the only thing
      // preserving the never-pushed commits once the local branch is deleted.
      // It must exist before the worktree leaves its original location.
      const keepRefIndex = mockGitService.updateRef.mock.calls.findIndex(([ref]) =>
        (ref as string).startsWith("refs/sync-worktrees/keep/diverged-"),
      );
      expect(keepRefIndex).toBeGreaterThanOrEqual(0);
      expect(mockGitService.updateRef.mock.calls[keepRefIndex][1]).toBe("new-local-commit");
      const keepRefOrder = mockGitService.updateRef.mock.invocationCallOrder[keepRefIndex];
      const renameOrder = (fs.rename as Mock<any>).mock.invocationCallOrder[0];
      expect(keepRefOrder).toBeLessThan(renameOrder);

      // The stale local branch must be gone before addWorktree, or the fresh
      // worktree would be created from it instead of from upstream.
      expect(mockGitService.deleteLocalBranch).toHaveBeenCalledWith("feature-1");
      const deleteBranchOrder = mockGitService.deleteLocalBranch.mock.invocationCallOrder[0];
      const addOrder = mockGitService.addWorktree.mock.invocationCallOrder[0];
      expect(deleteBranchOrder).toBeLessThan(addOrder);
    });

    it("with trash enabled, trashes the diverged worktree with keepPinOnReap so its commits survive trash expiry", async () => {
      service = new WorktreeSyncService({ ...mockConfig, trash: undefined });

      mockGitService.canFastForward.mockResolvedValue(false);
      mockGitService.isLocalAheadOfRemote.mockResolvedValue(false);
      mockGitService.compareTreeContent.mockResolvedValue(false);
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasOperationInProgress.mockResolvedValue(false);
      mockGitService.getWorktreeMetadata.mockResolvedValue({
        lastSyncCommit: "old-commit",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/feature-1",
        createdFrom: { branch: "main", commit: "old-commit" },
        syncHistory: [],
      });
      mockGitService.getCurrentCommit.mockResolvedValue("new-local-commit");
      mockGitService.getRemoteCommit.mockResolvedValue("remote-commit");

      (fs.rename as Mock<any>).mockResolvedValue(undefined);

      await service.sync();

      // diverged-replace trashes the only copy of never-pushed commits, so the
      // pin must outlive trash expiry and be backed by a bundle.
      const manifestWrite = findLastManifestWrite();
      expect(manifestWrite).toBeDefined();
      expect(JSON.parse(manifestWrite!.content)).toMatchObject({
        branch: "feature-1",
        reason: "diverged-replace",
        keepPinOnReap: true,
      });
      expect(mockGitService.createBundleFromRef).toHaveBeenCalledWith(
        expect.stringContaining("commits.bundle"),
        expect.stringContaining("refs/sync-worktrees/trash/"),
      );
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature-1", "/test/worktrees/feature-1");
    });

    it("should skip diverged branch handling when local is ahead of remote", async () => {
      mockGitService.canFastForward.mockResolvedValue(false);
      mockGitService.isLocalAheadOfRemote.mockResolvedValue(true);
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasOperationInProgress.mockResolvedValue(false);

      await service.sync();

      expect(mockGitService.compareTreeContent).not.toHaveBeenCalled();
      expect(mockGitService.resetToUpstream).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("has unpushed commits"));
    });

    it("should count update task as success when fast-forward fails but diverged recovery succeeds", async () => {
      mockGitService.canFastForward.mockResolvedValue(true);
      mockGitService.isWorktreeBehind.mockResolvedValue(true);
      mockGitService.updateWorktree.mockRejectedValue(new Error("Not possible to fast-forward, aborting"));
      mockGitService.isLocalAheadOfRemote.mockResolvedValue(false);
      mockGitService.compareTreeContent.mockResolvedValue(true);
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasOperationInProgress.mockResolvedValue(false);

      await service.sync();

      expect(mockGitService.resetToUpstream).toHaveBeenCalledWith("/test/worktrees/feature-1", "feature-1");
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Processed 1/1 worktrees successfully"));
    });

    it("should surface failure and skip worktree recreation when both rename and copy fallback fail", async () => {
      mockGitService.canFastForward.mockResolvedValue(false);
      mockGitService.isLocalAheadOfRemote.mockResolvedValue(false);
      mockGitService.compareTreeContent.mockResolvedValue(false);
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasOperationInProgress.mockResolvedValue(false);
      mockGitService.getWorktreeMetadata.mockResolvedValue({
        lastSyncCommit: "old-commit",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/feature-1",
        createdFrom: { branch: "main", commit: "old-commit" },
        syncHistory: [],
      });
      mockGitService.getCurrentCommit.mockResolvedValue("new-local-commit");
      mockGitService.getRemoteCommit.mockResolvedValue("remote-commit");

      (fs.rename as Mock<any>).mockRejectedValue(
        Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }),
      );
      (fs.cp as Mock<any>).mockRejectedValue(new Error("copy failed"));

      await service.sync();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(mockGitService.addWorktree).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to handle diverged branch"),
        expect.any(Error),
      );
    });

    it("writes .diverged-info.json with branch, commits and timestamp when diverging", async () => {
      mockGitService.canFastForward.mockResolvedValue(false);
      mockGitService.isLocalAheadOfRemote.mockResolvedValue(false);
      mockGitService.compareTreeContent.mockResolvedValue(false);
      mockGitService.checkWorktreeStatus.mockResolvedValue(true);
      mockGitService.hasOperationInProgress.mockResolvedValue(false);
      mockGitService.getWorktreeMetadata.mockResolvedValue({
        lastSyncCommit: "old-commit",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/feature-1",
        createdFrom: { branch: "main", commit: "old-commit" },
        syncHistory: [],
      });
      mockGitService.getCurrentCommit.mockResolvedValue("new-local-commit");
      mockGitService.getRemoteCommit.mockResolvedValue("remote-commit");

      (fs.rename as Mock<any>).mockResolvedValue(undefined);

      await service.sync();

      const infoCall = (fs.writeFile as Mock<any>).mock.calls.find((call) =>
        String(call[0]).endsWith(".diverged-info.json"),
      );
      expect(infoCall).toBeDefined();
      const parsed = JSON.parse(infoCall![1] as string);
      expect(parsed.originalBranch).toBe("feature-1");
      expect(parsed.localCommit).toBe("new-local-commit");
      expect(parsed.remoteCommit).toBe("remote-commit");
      expect(typeof parsed.divergedAt).toBe("string");
      expect(Number.isNaN(Date.parse(parsed.divergedAt))).toBe(false);
    });
  });

  describe("retry behavior", () => {
    let retryConfig: Config;
    let retrySyncService: WorktreeSyncService;
    let mockRetryLogger: Logger;

    beforeEach(async () => {
      mockRetryLogger = createMockLogger();

      retryConfig = {
        repoUrl: "https://github.com/test/repo.git",
        worktreeDir: "/test/worktrees",
        cronSchedule: "0 * * * *",
        runOnce: false,
        logger: mockRetryLogger,
        retry: {
          maxAttempts: 3,
          initialDelayMs: 10,
          maxDelayMs: 50,
        },
      };

      retrySyncService = new WorktreeSyncService(retryConfig);
      await retrySyncService.initialize();
    });

    it("should retry entire sync operation on network errors", async () => {
      const networkError = new Error("Network connection failed");
      (networkError as any).code = "ECONNREFUSED";

      mockGitService.fetchAll.mockRejectedValueOnce(networkError).mockResolvedValueOnce(undefined);
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "develop"]);
      mockGitService.getWorktrees.mockResolvedValue([{ path: path.join("/test/worktrees", "main"), branch: "main" }]);
      mockGitService.getCurrentBranch.mockResolvedValue("main");
      mockGitService.pruneWorktrees.mockResolvedValue(undefined);

      await retrySyncService.sync();

      expect(mockGitService.fetchAll).toHaveBeenCalledTimes(2);
    });

    it("should retry on filesystem errors during sync", async () => {
      const fsError = new Error("Resource temporarily unavailable");
      (fsError as any).code = "EBUSY";

      mockGitService.fetchAll.mockResolvedValue(undefined);
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "develop"]);
      mockGitService.getWorktrees
        .mockRejectedValueOnce(fsError)
        .mockResolvedValue([{ path: path.join("/test/worktrees", "main"), branch: "main" }]);
      mockGitService.getCurrentBranch.mockResolvedValue("main");
      mockGitService.pruneWorktrees.mockResolvedValue(undefined);

      await retrySyncService.sync();

      expect(mockGitService.getWorktrees).toHaveBeenCalledTimes(2);
    });

    it("should respect maxAttempts configuration", async () => {
      const error = new Error("Persistent network error");
      (error as any).code = "ETIMEDOUT";

      mockGitService.fetchAll.mockRejectedValue(error);

      await expect(retrySyncService.sync()).rejects.toThrow("Persistent network error");

      expect(mockGitService.fetchAll).toHaveBeenCalledTimes(3);
    });

    it("should not retry on non-retryable errors", async () => {
      const authError = new Error("Authentication failed");
      mockGitService.fetchAll.mockRejectedValue(authError);

      await expect(retrySyncService.sync()).rejects.toThrow("Authentication failed");

      expect(mockGitService.fetchAll).toHaveBeenCalledTimes(1);
    });

    it("should retry indefinitely when configured", async () => {
      const unlimitedConfig: Config = {
        ...retryConfig,
        retry: {
          maxAttempts: "unlimited",
          initialDelayMs: 1,
          maxDelayMs: 5,
        },
      };

      const unlimitedSyncService = new WorktreeSyncService(unlimitedConfig);
      await unlimitedSyncService.initialize();

      let attempts = 0;
      mockGitService.fetchAll.mockImplementation(() => {
        attempts++;
        if (attempts < 5) {
          const error = new Error("Network error");
          (error as any).code = "ECONNREFUSED";
          return Promise.reject(error);
        }
        return Promise.resolve(undefined);
      });

      mockGitService.getRemoteBranches.mockResolvedValue(["main"]);
      mockGitService.getWorktrees.mockResolvedValue([]);
      mockGitService.getCurrentBranch.mockResolvedValue("main");
      mockGitService.pruneWorktrees.mockResolvedValue(undefined);

      await unlimitedSyncService.sync();

      expect(mockGitService.fetchAll).toHaveBeenCalledTimes(5);
    });

    it("should log retry attempts", async () => {
      const error = new Error("Network timeout");
      (error as any).code = "ETIMEDOUT";

      mockGitService.fetchAll
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(undefined);

      mockGitService.getRemoteBranches.mockResolvedValue(["main"]);
      mockGitService.getWorktrees.mockResolvedValue([]);
      mockGitService.getCurrentBranch.mockResolvedValue("main");
      mockGitService.pruneWorktrees.mockResolvedValue(undefined);

      await retrySyncService.sync();

      expect(mockRetryLogger.info).toHaveBeenCalledWith(expect.stringContaining("⚠️  Sync attempt 1 failed"));
      expect(mockRetryLogger.info).toHaveBeenCalledWith(expect.stringContaining("🔄 Retrying synchronization"));
      expect(mockRetryLogger.info).toHaveBeenCalledWith(expect.stringContaining("⚠️  Sync attempt 2 failed"));
    });

    it("should complete sync if only non-critical operations fail", async () => {
      mockGitService.fetchAll.mockResolvedValue(undefined);
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "develop"]);
      mockGitService.getWorktrees.mockResolvedValue([{ path: path.join("/test/worktrees", "main"), branch: "main" }]);
      mockGitService.getCurrentBranch.mockResolvedValue("main");

      const pruneError = new Error("Prune failed");
      (pruneError as any).code = "EBUSY";
      mockGitService.pruneWorktrees
        .mockRejectedValueOnce(pruneError)
        .mockRejectedValueOnce(pruneError)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue(undefined);

      await retrySyncService.sync();

      expect(mockGitService.fetchAll).toHaveBeenCalled();
      expect(mockGitService.getRemoteBranches).toHaveBeenCalled();
      expect(mockGitService.pruneWorktrees).toHaveBeenCalledTimes(4);
    });
  });

  describe("sparseCheckout reapply on existing worktrees", () => {
    function makeSparseService(): WorktreeSyncService {
      const cfg: Config = {
        ...mockConfig,
        runOnce: true,
        sparseCheckout: { include: ["apps"] },
      };
      const sparseSvc = new WorktreeSyncService(cfg);
      return sparseSvc;
    }

    let applyToWorktree: Mock<any>;
    let readCurrent: Mock<any>;
    let isNarrowing: Mock<any>;

    beforeEach(() => {
      applyToWorktree = vi.fn().mockResolvedValue(undefined);
      readCurrent = vi.fn();
      isNarrowing = vi.fn();
      mockGitService.getSparseCheckoutService.mockReturnValue({
        applyToWorktree,
        readCurrent,
        isNarrowing,
        buildPatterns: vi.fn().mockReturnValue(["apps"]),
        needsUpdate: vi.fn().mockResolvedValue(true),
        resolveMode: vi.fn(),
        patternsEqual: vi.fn((a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])),
      } as any);
      (fs.access as Mock).mockResolvedValue(undefined);
      (fs.mkdir as Mock).mockResolvedValue(undefined);
      mockGitService.getRemoteBranches.mockResolvedValue(["main"]);
      mockGitService.getWorktrees.mockResolvedValue([{ path: wtPath("/test/worktrees", "main"), branch: "main" }]);
    });

    it("skips when current matches desired", async () => {
      readCurrent.mockResolvedValue(["apps"]);
      isNarrowing.mockReturnValue(false);

      const svc = makeSparseService();
      await svc.sync();

      expect(applyToWorktree).not.toHaveBeenCalled();
    });

    it("applies and checks out when widening (current is subset of desired)", async () => {
      readCurrent.mockResolvedValue(null);
      isNarrowing.mockReturnValue(false);

      const svc = makeSparseService();
      await svc.sync();

      expect(applyToWorktree).toHaveBeenCalled();
      expect(mockGitService.checkoutHead).toHaveBeenCalled();
    });

    it("skips narrowing when worktree is dirty", async () => {
      readCurrent.mockResolvedValue(["apps", "packages"]);
      isNarrowing.mockReturnValue(true);
      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: false,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        fullyPushedUpstreamDeleted: false,
        canRemove: false,
        reasons: ["uncommitted changes"],
      });

      const svc = makeSparseService();
      await svc.sync();

      expect(applyToWorktree).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Skipping sparse-checkout narrowing"));
    });

    it("skips narrowing when worktree has unpushed commits", async () => {
      readCurrent.mockResolvedValue(["apps", "packages"]);
      isNarrowing.mockReturnValue(true);
      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: true,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        fullyPushedUpstreamDeleted: false,
        canRemove: false,
        reasons: ["unpushed commits"],
      });

      const svc = makeSparseService();
      await svc.sync();

      expect(applyToWorktree).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("unpushed commits"));
    });

    it("skips narrowing when worktree has operation in progress", async () => {
      readCurrent.mockResolvedValue(["apps", "packages"]);
      isNarrowing.mockReturnValue(true);
      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: true,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        fullyPushedUpstreamDeleted: false,
        canRemove: false,
        reasons: ["rebase in progress"],
      });

      const svc = makeSparseService();
      await svc.sync();

      expect(applyToWorktree).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("rebase in progress"));
    });

    it("applies narrowing when worktree is clean", async () => {
      readCurrent.mockResolvedValue(["apps", "packages"]);
      isNarrowing.mockReturnValue(true);
      mockGitService.getFullWorktreeStatus.mockResolvedValue({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        fullyPushedUpstreamDeleted: false,
        canRemove: true,
        reasons: [],
      });

      const svc = makeSparseService();
      await svc.sync();

      expect(applyToWorktree).toHaveBeenCalled();
      expect(mockGitService.checkoutHead).toHaveBeenCalled();
    });

    it("does nothing when sparseCheckout is unset", async () => {
      readCurrent.mockResolvedValue(["apps"]);
      isNarrowing.mockReturnValue(false);
      // service WITHOUT sparseCheckout
      await service.sync();
      expect(applyToWorktree).not.toHaveBeenCalled();
      expect(mockGitService.getSparseCheckoutService).not.toHaveBeenCalled();
    });

    it("continues sync and warns when readCurrent throws", async () => {
      readCurrent.mockRejectedValue(new Error("boom"));
      isNarrowing.mockReturnValue(false);

      const svc = makeSparseService();
      await expect(svc.sync()).resolves.not.toThrow();

      expect(applyToWorktree).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to update sparse-checkout"));
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    });
  });

  describe("checkoutBranch wrapper", () => {
    it("rejects with a typed ConfigError on a worktree-mode repository", async () => {
      const svc = new WorktreeSyncService(mockConfig);
      await expect(svc.checkoutBranch("feature/new")).rejects.toMatchObject({
        constructor: ConfigError,
        code: "CONFIG_CLONE_MODE_REQUIRED",
      });
    });
  });

  describe("maintenance wiring", () => {
    let maintenanceSpy: ReturnType<typeof vi.spyOn>;
    let prevNodeEnv: string | undefined;

    beforeEach(() => {
      // The call site is gated off under NODE_ENV=test; flip it so the wiring runs.
      // Stub the cross-process lock so flipping the env doesn't trigger real locking.
      prevNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      vi.spyOn(RepoOperationLock.prototype, "acquire").mockResolvedValue(async () => {});
      maintenanceSpy = vi.spyOn(GitMaintenanceService.prototype, "runIfDueUnlocked").mockResolvedValue(undefined);
    });

    afterEach(() => {
      process.env.NODE_ENV = prevNodeEnv;
      vi.restoreAllMocks();
    });

    it("runs maintenance once after a successful sync, inside the lock", async () => {
      // gc must complete before the cross-process lock is released — after
      // release another process may already be mutating the repo.
      const release = vi.fn(async () => {});
      vi.spyOn(RepoOperationLock.prototype, "acquire").mockResolvedValue(
        release as Awaited<ReturnType<RepoOperationLock["acquire"]>>,
      );

      const svc = new WorktreeSyncService(mockConfig);
      await svc.sync();

      expect(maintenanceSpy).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(maintenanceSpy.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]);
    });

    it("does not run maintenance when the sync fails", async () => {
      mockGitService.fetchAll.mockRejectedValue(new Error("Fetch failed"));
      const svc = new WorktreeSyncService(mockConfig);
      await expect(svc.sync()).rejects.toThrow("Fetch failed");
      expect(maintenanceSpy).not.toHaveBeenCalled();
    });
  });
});
