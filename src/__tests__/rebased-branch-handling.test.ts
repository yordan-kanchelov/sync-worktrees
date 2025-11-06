import * as fs from "fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorktreeSyncService } from "../services/worktree-sync.service";

import type { GitService } from "../services/git.service";
import type { Config } from "../types";
import type { Mock, Mocked } from "vitest";

vi.mock("fs/promises");

const { mockGitServiceInstance } = vi.hoisted(() => {
  return {
    mockGitServiceInstance: {
      initialize: vi.fn<any>().mockResolvedValue(undefined),
      fetchAll: vi.fn<any>().mockResolvedValue(undefined),
      getRemoteBranches: vi.fn<any>().mockResolvedValue(["main", "feature-rebased", "feature-diverged"]),
      addWorktree: vi.fn<any>().mockResolvedValue(undefined),
      removeWorktree: vi.fn<any>().mockResolvedValue(undefined),
      pruneWorktrees: vi.fn<any>().mockResolvedValue(undefined),
      checkWorktreeStatus: vi.fn<any>().mockResolvedValue(true),
      hasUnpushedCommits: vi.fn<any>().mockResolvedValue(false),
      hasUpstreamGone: vi.fn<any>().mockResolvedValue(false),
      hasStashedChanges: vi.fn<any>().mockResolvedValue(false),
      hasOperationInProgress: vi.fn<any>().mockResolvedValue(false),
      hasModifiedSubmodules: vi.fn<any>().mockResolvedValue(false),
      getCurrentBranch: vi.fn<any>().mockResolvedValue("main"),
      getDefaultBranch: vi.fn().mockReturnValue("main"),
      getWorktrees: vi.fn<any>().mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature-rebased", branch: "feature-rebased" },
        { path: "/test/worktrees/feature-diverged", branch: "feature-diverged" },
      ]),
      isWorktreeBehind: vi.fn<any>().mockResolvedValue(false),
      updateWorktree: vi.fn<any>().mockResolvedValue(undefined),
      hasDivergedHistory: vi.fn<any>().mockResolvedValue(false),
      canFastForward: vi.fn<any>().mockResolvedValue(true),
      compareTreeContent: vi.fn<any>().mockResolvedValue(false),
      resetToUpstream: vi.fn<any>().mockResolvedValue(undefined),
      getCurrentCommit: vi.fn<any>().mockResolvedValue("abc123"),
      getRemoteCommit: vi.fn<any>().mockResolvedValue("def456"),
      getWorktreeMetadata: vi.fn<any>().mockResolvedValue(null),
      getGit: vi.fn<any>(),
    } as any,
  };
});

vi.mock("../services/git.service", () => ({
  GitService: vi.fn(function (this: any) {
    return mockGitServiceInstance;
  }),
}));

describe("Rebased Branch Handling", () => {
  let service: WorktreeSyncService;
  let mockConfig: Config;
  let mockGitService: Mocked<GitService>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir: "/test/worktrees",
      cronSchedule: "0 * * * *",
      runOnce: true,
      updateExistingWorktrees: true,
    };

    mockGitService = mockGitServiceInstance;

    service = new WorktreeSyncService(mockConfig);
  });

  describe("Clean rebase (identical content)", () => {
    it("should reset branch when content is identical after rebase", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue([]);
      (fs.access as Mock<any>).mockResolvedValue(undefined);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue([]);
      (fs.access as Mock<any>).mockResolvedValue(undefined);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue([]);
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      (fs.rename as Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as Mock<any>).mockResolvedValue(undefined);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue([]);
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      (fs.rename as Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as Mock<any>).mockResolvedValue(undefined);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockImplementation(async (dirPath) => {
        if ((dirPath as string).endsWith(".diverged")) {
          const error: any = new Error("ENOENT: no such file or directory");
          error.code = "ENOENT";
          throw error;
        }
        return [];
      });
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      (fs.rename as Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as Mock<any>).mockResolvedValue(undefined);

      // Ensure getRemoteBranches and getWorktrees return the worktrees
      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-rebased", "feature-diverged"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature-rebased", branch: "feature-rebased" },
        { path: "/test/worktrees/feature-diverged", branch: "feature-diverged" },
      ]);

      // Mock worktree to be behind to trigger update flow
      mockGitService.isWorktreeBehind.mockImplementation(async (path) => {
        return path.includes("feature-diverged");
      });

      // Mock update to throw fast-forward error for diverged branch
      mockGitService.updateWorktree.mockImplementation(async (path) => {
        if (path.includes("feature-diverged")) {
          throw new Error("fatal: Not possible to fast-forward, aborting.");
        }
      });

      mockGitService.canFastForward.mockImplementation(async (path) => {
        return !path.includes("feature-diverged");
      });

      mockGitService.compareTreeContent.mockResolvedValue(false);

      await service.sync();

      expect(fs.mkdir).toHaveBeenCalledWith("/test/worktrees", { recursive: true });

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.access as Mock<any>).mockResolvedValue(undefined);

      (fs.readdir as Mock<any>).mockImplementation(async (path) => {
        if ((path as string).endsWith(".diverged")) {
          return ["2024-01-01-old-branch", "2024-01-15-another-branch"];
        }
        return [];
      });

      const consoleSpy = vi.spyOn(console, "log");

      await service.sync();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("📦 Note: 2 diverged worktree(s)"));
    });

    it("should ignore .diverged directory during cleanup", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.access as Mock<any>).mockResolvedValue(undefined);

      (fs.readdir as Mock<any>).mockImplementation(async (path) => {
        if (path === "/test/worktrees") {
          return ["main", "feature", ".diverged", "orphaned-dir"];
        }
        return [];
      });

      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature", branch: "feature" },
      ]);

      const mockStat = vi.fn<any>().mockResolvedValue({ isDirectory: () => true });
      (fs.stat as Mock<any>).mockImplementation(mockStat);
      (fs.rm as Mock<any>).mockResolvedValue(undefined);

      await service.sync();

      expect(fs.rm).toHaveBeenCalledTimes(1);
      expect(fs.rm).toHaveBeenCalledWith("/test/worktrees/orphaned-dir", { recursive: true, force: true });
      expect(fs.rm).not.toHaveBeenCalledWith(expect.stringContaining(".diverged"), expect.any(Object));
    });
  });

  describe("Edge cases", () => {
    it("should handle multiple diverged branches in single sync", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue([]);
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      (fs.rename as Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as Mock<any>).mockResolvedValue(undefined);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue([]);
      (fs.access as Mock<any>).mockResolvedValue(undefined);

      (fs.rename as Mock<any>).mockRejectedValue(new Error("Permission denied"));

      mockGitService.canFastForward.mockResolvedValue(false);
      mockGitService.compareTreeContent.mockResolvedValue(false);

      const consoleSpy = vi.spyOn(console, "error");

      await service.sync();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Error checking worktree"), expect.any(Error));
    });

    it("should handle branch names with special characters", async () => {
      await service.initialize();
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue([]);
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      (fs.rename as Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as Mock<any>).mockResolvedValue(undefined);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue([]);
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      (fs.rename as Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as Mock<any>).mockResolvedValue(undefined);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue([]);
      (fs.access as Mock<any>).mockResolvedValue(undefined);
      (fs.rename as Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as Mock<any>).mockResolvedValue(undefined);

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
      (fs.mkdir as Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as Mock<any>).mockResolvedValue([]);
      (fs.access as Mock<any>).mockResolvedValue(undefined);

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

      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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
