import * as fs from "fs/promises";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { GitService } from "../services/git.service";
import { WorktreeSyncService } from "../services/worktree-sync.service";

import type { Config } from "../types";

jest.mock("fs/promises");
jest.mock("../services/git.service");

describe("Rebased Branch Handling", () => {
  let service: WorktreeSyncService;
  let mockConfig: Config;
  let mockGitService: jest.Mocked<GitService>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConfig = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/test/worktrees",
      cronSchedule: "0 * * * *",
      runOnce: true,
      updateExistingWorktrees: true,
    };

    mockGitService = {
      initialize: jest.fn<any>().mockResolvedValue(undefined),
      fetchAll: jest.fn<any>().mockResolvedValue(undefined),
      getRemoteBranches: jest.fn<any>().mockResolvedValue(["main", "feature-rebased", "feature-diverged"]),
      addWorktree: jest.fn<any>().mockResolvedValue(undefined),
      removeWorktree: jest.fn<any>().mockResolvedValue(undefined),
      pruneWorktrees: jest.fn<any>().mockResolvedValue(undefined),
      checkWorktreeStatus: jest.fn<any>().mockResolvedValue(true),
      hasUnpushedCommits: jest.fn<any>().mockResolvedValue(false),
      hasUpstreamGone: jest.fn<any>().mockResolvedValue(false),
      hasStashedChanges: jest.fn<any>().mockResolvedValue(false),
      hasOperationInProgress: jest.fn<any>().mockResolvedValue(false),
      hasModifiedSubmodules: jest.fn<any>().mockResolvedValue(false),
      getCurrentBranch: jest.fn<any>().mockResolvedValue("main"),
      getDefaultBranch: jest.fn().mockReturnValue("main"),
      getWorktrees: jest.fn<any>().mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature-rebased", branch: "feature-rebased" },
        { path: "/test/worktrees/feature-diverged", branch: "feature-diverged" },
      ]),
      isWorktreeBehind: jest.fn<any>().mockResolvedValue(false),
      updateWorktree: jest.fn<any>().mockResolvedValue(undefined),
      hasDivergedHistory: jest.fn<any>().mockResolvedValue(false),
      canFastForward: jest.fn<any>().mockResolvedValue(true),
      compareTreeContent: jest.fn<any>().mockResolvedValue(false),
      resetToUpstream: jest.fn<any>().mockResolvedValue(undefined),
      getCurrentCommit: jest.fn<any>().mockResolvedValue("abc123"),
      getRemoteCommit: jest.fn<any>().mockResolvedValue("def456"),
      getWorktreeMetadata: jest.fn<any>().mockResolvedValue(null),
      getGit: jest.fn<any>(),
    } as any;

    (GitService as jest.MockedClass<typeof GitService>).mockImplementation(() => mockGitService);

    service = new WorktreeSyncService(mockConfig);
  });

  describe("Clean rebase (identical content)", () => {
    it("should reset branch when content is identical after rebase", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue([]);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);

      mockGitService.canFastForward.mockImplementation(async (path) => {
        return !path.includes("feature-rebased");
      });

      mockGitService.compareTreeContent.mockImplementation(async (path) => {
        return path.includes("feature-rebased");
      });

      await service.sync();

      expect(mockGitService.resetToUpstream).toHaveBeenCalledWith("/test/worktrees/feature-rebased", "feature-rebased");

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(fs.rename).not.toHaveBeenCalled();
    });
  });

  describe("Smart divergence detection", () => {
    it("should reset to upstream when diverged but no local changes made", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue([]);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);

      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-no-local-changes"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature-no-local-changes", branch: "feature-no-local-changes" },
      ]);

      mockGitService.canFastForward.mockImplementation(async (path) => {
        return !path.includes("feature-no-local-changes");
      });

      mockGitService.compareTreeContent.mockResolvedValue(false);

      mockGitService.getWorktreeMetadata.mockResolvedValue({
        lastSyncCommit: "abc123",
        lastSyncDate: "2024-01-01T00:00:00.000Z",
        upstreamBranch: "origin/feature-no-local-changes",
        createdFrom: { branch: "main", commit: "xyz789" },
        syncHistory: [],
      });

      mockGitService.getCurrentCommit.mockResolvedValue("abc123");

      await service.sync();

      expect(mockGitService.resetToUpstream).toHaveBeenCalledWith(
        "/test/worktrees/feature-no-local-changes",
        "feature-no-local-changes",
      );
      expect(fs.rename).not.toHaveBeenCalled();
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("should move to diverged when diverged with local changes", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue([]);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.rename as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-with-local-changes"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature-with-local-changes", branch: "feature-with-local-changes" },
      ]);

      mockGitService.canFastForward.mockImplementation(async (path) => {
        return !path.includes("feature-with-local-changes");
      });

      mockGitService.compareTreeContent.mockResolvedValue(false);

      mockGitService.getWorktreeMetadata.mockResolvedValue({
        lastSyncCommit: "abc123",
        lastSyncDate: "2024-01-01T00:00:00.000Z",
        upstreamBranch: "origin/feature-with-local-changes",
        createdFrom: { branch: "main", commit: "xyz789" },
        syncHistory: [],
      });

      mockGitService.getCurrentCommit.mockResolvedValue("local456");

      await service.sync();

      expect(fs.mkdir).toHaveBeenCalledWith("/test/worktrees/.diverged", { recursive: true });
      expect(fs.rename).toHaveBeenCalledWith(
        "/test/worktrees/feature-with-local-changes",
        expect.stringMatching(/\/test\/worktrees\/\.diverged\/\d{4}-\d{2}-\d{2}-feature-with-local-changes-[a-z0-9]+$/),
      );
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith("/test/worktrees/feature-with-local-changes");
      expect(mockGitService.addWorktree).toHaveBeenCalledWith(
        "feature-with-local-changes",
        "/test/worktrees/feature-with-local-changes",
      );
    });

    it("should move to diverged when metadata is missing (safer default)", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue([]);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.rename as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-no-metadata"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature-no-metadata", branch: "feature-no-metadata" },
      ]);

      mockGitService.canFastForward.mockImplementation(async (path) => {
        return !path.includes("feature-no-metadata");
      });

      mockGitService.compareTreeContent.mockResolvedValue(false);

      mockGitService.getWorktreeMetadata.mockResolvedValue(null);

      await service.sync();

      expect(fs.mkdir).toHaveBeenCalledWith("/test/worktrees/.diverged", { recursive: true });
      expect(fs.rename).toHaveBeenCalledWith(
        "/test/worktrees/feature-no-metadata",
        expect.stringMatching(/\/test\/worktrees\/\.diverged\/\d{4}-\d{2}-\d{2}-feature-no-metadata-[a-z0-9]+$/),
      );
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith("/test/worktrees/feature-no-metadata");
      expect(mockGitService.addWorktree).toHaveBeenCalledWith(
        "feature-no-metadata",
        "/test/worktrees/feature-no-metadata",
      );
    });
  });

  describe("Diverged branch with different content", () => {
    it("should move branch to diverged when content differs after rebase", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue([]);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.rename as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      mockGitService.canFastForward.mockImplementation(async (path) => {
        return !path.includes("feature-diverged");
      });

      mockGitService.compareTreeContent.mockResolvedValue(false);

      await service.sync();

      expect(fs.mkdir).toHaveBeenCalledWith("/test/worktrees/.diverged", { recursive: true });

      expect(fs.rename).toHaveBeenCalledWith(
        "/test/worktrees/feature-diverged",
        expect.stringMatching(/\/test\/worktrees\/\.diverged\/\d{4}-\d{2}-\d{2}-feature-diverged-[a-z0-9]+$/),
      );

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/\.diverged-info\.json$/),
        expect.stringContaining("diverged-history-with-changes"),
      );

      expect(mockGitService.removeWorktree).toHaveBeenCalledWith("/test/worktrees/feature-diverged");
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature-diverged", "/test/worktrees/feature-diverged");
    });
  });

  describe("Diverged directory management", () => {
    it("should report existing diverged worktrees", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);

      (fs.readdir as jest.Mock<any>).mockImplementation(async (path: string) => {
        if (path.endsWith(".diverged")) {
          return ["2024-01-01-old-branch", "2024-01-15-another-branch"];
        }
        return [];
      });

      const consoleSpy = jest.spyOn(console, "log");

      await service.sync();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("📦 Note: 2 diverged worktree(s)"));
    });

    it("should ignore .diverged directory during cleanup", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);

      (fs.readdir as jest.Mock<any>).mockImplementation(async (path: string) => {
        if (path === "/test/worktrees") {
          return ["main", "feature", ".diverged", "orphaned-dir"];
        }
        return [];
      });

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature", branch: "feature" },
      ]);

      const mockStat = jest.fn<any>().mockResolvedValue({ isDirectory: () => true });
      (fs.stat as jest.Mock<any>).mockImplementation(mockStat);
      (fs.rm as jest.Mock<any>).mockResolvedValue(undefined);

      await service.sync();

      expect(fs.rm).toHaveBeenCalledTimes(1);
      expect(fs.rm).toHaveBeenCalledWith("/test/worktrees/orphaned-dir", { recursive: true, force: true });
      expect(fs.rm).not.toHaveBeenCalledWith(expect.stringContaining(".diverged"), expect.any(Object));
    });
  });

  describe("Edge cases", () => {
    it("should handle multiple diverged branches in single sync", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue([]);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.rename as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      mockGitService.getRemoteBranches.mockResolvedValue(["main", "branch1", "branch2"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/branch1", branch: "branch1" },
        { path: "/test/worktrees/branch2", branch: "branch2" },
      ]);

      mockGitService.canFastForward.mockResolvedValue(false);

      mockGitService.compareTreeContent.mockImplementation(async (path) => {
        return path.includes("branch1");
      });

      await service.sync();

      expect(mockGitService.resetToUpstream).toHaveBeenCalledWith("/test/worktrees/branch1", "branch1");

      expect(fs.rename).toHaveBeenCalledWith(
        "/test/worktrees/branch2",
        expect.stringMatching(/\/test\/worktrees\/\.diverged\/\d{4}-\d{2}-\d{2}-branch2-[a-z0-9]+$/),
      );
    });

    it("should handle errors during divergence gracefully", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue([]);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);

      (fs.rename as jest.Mock<any>).mockRejectedValue(new Error("Permission denied"));

      mockGitService.canFastForward.mockResolvedValue(false);
      mockGitService.compareTreeContent.mockResolvedValue(false);

      const consoleSpy = jest.spyOn(console, "error");

      await service.sync();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Error checking worktree"), expect.any(Error));
    });

    it("should handle branch names with special characters", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue([]);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.rename as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      const specialBranches = ["feature/user@domain", "bugfix/issue#123", "release/v1.0.0"];
      mockGitService.getRemoteBranches.mockResolvedValue(["main", ...specialBranches]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature/user@domain", branch: "feature/user@domain" },
        { path: "/test/worktrees/bugfix/issue#123", branch: "bugfix/issue#123" },
        { path: "/test/worktrees/release/v1.0.0", branch: "release/v1.0.0" },
      ]);

      mockGitService.canFastForward.mockResolvedValue(false);
      mockGitService.compareTreeContent.mockResolvedValue(false);

      await service.sync();

      expect(fs.rename).toHaveBeenCalledWith(
        "/test/worktrees/feature/user@domain",
        expect.stringMatching(/\/test\/worktrees\/\.diverged\/\d{4}-\d{2}-\d{2}-feature-user@domain-[a-z0-9]+$/),
      );
      expect(fs.rename).toHaveBeenCalledWith(
        "/test/worktrees/bugfix/issue#123",
        expect.stringMatching(/\/test\/worktrees\/\.diverged\/\d{4}-\d{2}-\d{2}-bugfix-issue#123-[a-z0-9]+$/),
      );
    });
  });

  describe("Diverged and behind branches", () => {
    it("should handle branches that are both behind and diverged correctly", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue([]);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.rename as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-diverged-behind"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature-diverged-behind", branch: "feature-diverged-behind" },
      ]);

      mockGitService.canFastForward.mockImplementation(async (path) => {
        return !path.includes("feature-diverged-behind");
      });

      mockGitService.isWorktreeBehind.mockImplementation(async (path) => {
        return path.includes("feature-diverged-behind");
      });

      mockGitService.compareTreeContent.mockResolvedValue(false);

      mockGitService.updateWorktree.mockImplementation(async (path) => {
        if (path.includes("feature-diverged-behind")) {
          const error = new Error("fatal: Not possible to fast-forward, aborting.") as any;
          error.task = {
            commands: ["merge", "origin/feature-diverged-behind", "--ff-only"],
            format: "utf-8",
          };
          throw error;
        }
      });

      await service.sync();

      expect(mockGitService.updateWorktree).not.toHaveBeenCalled();

      expect(fs.rename).toHaveBeenCalledWith(
        "/test/worktrees/feature-diverged-behind",
        expect.stringMatching(/\/test\/worktrees\/\.diverged\/\d{4}-\d{2}-\d{2}-feature-diverged-behind-[a-z0-9]+$/),
      );

      expect(mockGitService.removeWorktree).toHaveBeenCalledWith("/test/worktrees/feature-diverged-behind");
      expect(mockGitService.addWorktree).toHaveBeenCalledWith(
        "feature-diverged-behind",
        "/test/worktrees/feature-diverged-behind",
      );
    });

    it("should recover from fast-forward errors by handling as diverged branch", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue([]);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.rename as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-diverged-behind"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature-diverged-behind", branch: "feature-diverged-behind" },
      ]);

      mockGitService.canFastForward.mockResolvedValue(true);

      mockGitService.isWorktreeBehind.mockImplementation(async (path) => {
        return path.includes("feature-diverged-behind");
      });

      mockGitService.compareTreeContent.mockResolvedValue(false);

      mockGitService.updateWorktree.mockImplementation(async (path) => {
        if (path.includes("feature-diverged-behind")) {
          const error = new Error("fatal: Not possible to fast-forward, aborting.") as any;
          error.task = {
            commands: ["merge", "origin/feature-diverged-behind", "--ff-only"],
            format: "utf-8",
          };
          throw error;
        }
      });

      await service.sync();

      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/feature-diverged-behind");

      expect(fs.rename).toHaveBeenCalledWith(
        "/test/worktrees/feature-diverged-behind",
        expect.stringMatching(/\/test\/worktrees\/\.diverged\/\d{4}-\d{2}-\d{2}-feature-diverged-behind-[a-z0-9]+$/),
      );

      expect(mockGitService.removeWorktree).toHaveBeenCalledWith("/test/worktrees/feature-diverged-behind");
      expect(mockGitService.addWorktree).toHaveBeenCalledWith(
        "feature-diverged-behind",
        "/test/worktrees/feature-diverged-behind",
      );
    });

    it("should NOT treat other update errors as divergence", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue([]);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);

      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-diverged-behind"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature-diverged-behind", branch: "feature-diverged-behind" },
      ]);

      mockGitService.canFastForward.mockResolvedValue(true);

      mockGitService.isWorktreeBehind.mockImplementation(async (path) => {
        return path.includes("feature-diverged-behind");
      });

      mockGitService.updateWorktree.mockImplementation(async (path) => {
        if (path.includes("feature-diverged-behind")) {
          throw new Error(
            "fatal: unable to access 'https://github.com/test/repo.git/': Could not resolve host: github.com",
          );
        }
      });

      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      await service.sync();

      expect(mockGitService.updateWorktree).toHaveBeenCalledWith("/test/worktrees/feature-diverged-behind");

      expect(fs.rename).not.toHaveBeenCalled();
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(mockGitService.addWorktree).not.toHaveBeenCalledWith("feature-diverged-behind", expect.any(String));

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to update 'feature-diverged-behind':"),
        expect.objectContaining({
          message: expect.stringContaining("Could not resolve host"),
        }),
      );
    });
  });
});
