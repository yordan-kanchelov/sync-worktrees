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

      // Setup: feature-rebased cannot fast-forward
      mockGitService.canFastForward.mockImplementation(async (path) => {
        return !path.includes("feature-rebased");
      });

      // But trees are identical (clean rebase)
      mockGitService.compareTreeContent.mockImplementation(async (path) => {
        return path.includes("feature-rebased");
      });

      await service.sync();

      // Should reset to upstream
      expect(mockGitService.resetToUpstream).toHaveBeenCalledWith("/test/worktrees/feature-rebased", "feature-rebased");

      // Should not move to diverged or remove worktree
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(fs.rename).not.toHaveBeenCalled();
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

      // Setup: feature-diverged cannot fast-forward
      mockGitService.canFastForward.mockImplementation(async (path) => {
        return !path.includes("feature-diverged");
      });

      // Trees are different (real divergence)
      mockGitService.compareTreeContent.mockResolvedValue(false);

      await service.sync();

      // Should move the worktree to diverged
      expect(fs.mkdir).toHaveBeenCalledWith("/test/worktrees/.diverged", { recursive: true });

      expect(fs.rename).toHaveBeenCalledWith(
        "/test/worktrees/feature-diverged",
        expect.stringMatching(/\/test\/worktrees\/\.diverged\/\d{4}-\d{2}-\d{2}-feature-diverged-[a-z0-9]+$/),
      );

      // Should save metadata
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/\.diverged-info\.json$/),
        expect.stringContaining("diverged-history-with-changes"),
      );

      // Should remove and recreate worktree
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith("/test/worktrees/feature-diverged");
      expect(mockGitService.addWorktree).toHaveBeenCalledWith("feature-diverged", "/test/worktrees/feature-diverged");
    });
  });

  describe("Diverged directory management", () => {
    it("should report existing diverged worktrees", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);

      // Mock existing diverged directory
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

      // Mock directories including .diverged
      (fs.readdir as jest.Mock<any>).mockImplementation(async (path: string) => {
        if (path === "/test/worktrees") {
          return ["main", "feature", ".diverged", "orphaned-dir"];
        }
        return [];
      });

      // Mock that orphaned-dir is not a valid worktree
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature", branch: "feature" },
      ]);

      const mockStat = jest.fn<any>().mockResolvedValue({ isDirectory: () => true });
      (fs.stat as jest.Mock<any>).mockImplementation(mockStat);
      (fs.rm as jest.Mock<any>).mockResolvedValue(undefined);

      await service.sync();

      // Should only try to remove orphaned-dir, not .diverged
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

      // Both branches cannot fast-forward
      mockGitService.canFastForward.mockResolvedValue(false);

      // branch1 has identical trees, branch2 has different content
      mockGitService.compareTreeContent.mockImplementation(async (path) => {
        return path.includes("branch1");
      });

      await service.sync();

      // branch1 should be reset
      expect(mockGitService.resetToUpstream).toHaveBeenCalledWith("/test/worktrees/branch1", "branch1");

      // branch2 should be moved to diverged
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

      // Setup failing rename operation
      (fs.rename as jest.Mock<any>).mockRejectedValue(new Error("Permission denied"));

      mockGitService.canFastForward.mockResolvedValue(false);
      mockGitService.compareTreeContent.mockResolvedValue(false);

      // Should handle error gracefully and continue
      const consoleSpy = jest.spyOn(console, "error");

      await service.sync();

      // Verify error was logged
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

      // All special branches cannot fast-forward and have different content
      mockGitService.canFastForward.mockResolvedValue(false);
      mockGitService.compareTreeContent.mockResolvedValue(false);

      await service.sync();

      // Verify special characters are properly sanitized in diverged paths
      expect(fs.rename).toHaveBeenCalledWith(
        "/test/worktrees/feature/user@domain",
        expect.stringMatching(/\/test\/worktrees\/\.diverged\/\d{4}-\d{2}-\d{2}-feature-user@domain-[a-z0-9]+$/),
      );
      expect(fs.rename).toHaveBeenCalledWith(
        "/test/worktrees/bugfix/issue#123",
        expect.stringMatching(/\/test\/worktrees\/\.diverged\/\d{4}-\d{2}-\d{2}-bugfix-issue#123-[a-z0-9]+$/),
      );
    });

    it("should handle diverged directory with many entries and still report", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);

      // Mock a diverged directory with many entries
      const manyDivergedBranches = Array.from({ length: 100 }, (_, i) => `2024-01-01-branch${i}-abc123`);

      (fs.readdir as jest.Mock<any>).mockImplementation(async (path: string) => {
        if (path.endsWith(".diverged")) {
          return manyDivergedBranches;
        }
        return [];
      });

      const consoleSpy = jest.spyOn(console, "log");

      await service.sync();

      // Should report the large number correctly
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("📦 Note: 100 diverged worktree(s)"));
    });

    it("should handle concurrent divergence operations with unique names", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue([]);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      // Simulate delay in rename to test race condition handling
      let renameCallCount = 0;
      const renamedPaths: string[] = [];
      (fs.rename as jest.Mock<any>).mockImplementation(async (_: string, divergedPath: string) => {
        renameCallCount++;
        // Small delay to simulate concurrent operations
        await new Promise((resolve) => setTimeout(resolve, 10));
        renamedPaths.push(divergedPath);
        return undefined;
      });

      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-1", "feature-2"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature-1", branch: "feature-1" },
        { path: "/test/worktrees/feature-2", branch: "feature-2" },
      ]);

      // Both features cannot fast-forward
      mockGitService.canFastForward.mockImplementation(async (path) => {
        // Only feature branches cannot fast-forward
        return !path.includes("feature-");
      });
      mockGitService.compareTreeContent.mockResolvedValue(false);

      await service.sync();

      // Verify both branches were moved to diverged
      expect(renameCallCount).toBe(2);

      // Verify paths are unique (no collisions due to race condition)
      expect(new Set(renamedPaths).size).toBe(2);

      // Verify paths contain unique suffixes
      const suffixPattern = /-[a-z0-9]+$/;
      const suffixes = renamedPaths.map((path) => {
        const match = path.match(suffixPattern);
        return match ? match[0] : null;
      });
      expect(new Set(suffixes).size).toBe(2); // All suffixes should be unique
    });

    it("should handle filesystem errors during divergence", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue([]);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);

      // Mock filesystem full error
      (fs.mkdir as jest.Mock<any>).mockImplementation(async (path: string) => {
        if (path.includes(".diverged")) {
          throw new Error("ENOSPC: no space left on device");
        }
        return undefined;
      });

      mockGitService.canFastForward.mockResolvedValue(false);
      mockGitService.compareTreeContent.mockResolvedValue(false);

      const consoleSpy = jest.spyOn(console, "error");

      await service.sync();

      // Should log the filesystem error
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Error checking worktree"),
        expect.objectContaining({
          message: expect.stringContaining("ENOSPC"),
        }),
      );
    });

    it("should fallback to copy+remove on cross-device rename (EXDEV)", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue([]);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      // Simulate EXDEV failure on rename, then ensure cp and rm are used
      (fs.rename as jest.Mock<any>).mockRejectedValue(new Error("EXDEV: cross-device link not permitted"));
      (fs.cp as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.rm as jest.Mock<any>).mockResolvedValue(undefined);

      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature-x"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature-x", branch: "feature-x" },
      ]);

      mockGitService.canFastForward.mockImplementation(async (p) => !p.includes("feature-x"));
      mockGitService.compareTreeContent.mockResolvedValue(false);
      mockGitService.getCurrentCommit.mockResolvedValue("local");
      mockGitService.getRemoteCommit.mockResolvedValue("remote");

      await service.sync();

      expect(fs.cp).toHaveBeenCalled();
      expect(fs.rm).toHaveBeenCalled();
    });

    it("should preserve diverged metadata integrity", async () => {
      await service.initialize();
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock<any>).mockResolvedValue([]);
      (fs.access as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.rename as jest.Mock<any>).mockResolvedValue(undefined);

      let savedMetadata: any;
      (fs.writeFile as jest.Mock<any>).mockImplementation(async (_: string, content: string) => {
        savedMetadata = JSON.parse(content);
        return undefined;
      });

      mockGitService.getRemoteBranches.mockResolvedValue(["main", "feature/nested/branch"]);
      mockGitService.getWorktrees.mockResolvedValue([
        { path: "/test/worktrees/main", branch: "main" },
        { path: "/test/worktrees/feature/nested/branch", branch: "feature/nested/branch" },
      ]);

      mockGitService.canFastForward.mockResolvedValue(false);
      mockGitService.compareTreeContent.mockResolvedValue(false);
      mockGitService.getCurrentCommit.mockResolvedValue("local123");
      mockGitService.getRemoteCommit.mockResolvedValue("remote456");

      await service.sync();

      // Verify metadata contains all required fields
      expect(savedMetadata).toMatchObject({
        originalBranch: "feature/nested/branch",
        reason: "diverged-history-with-changes",
        originalPath: "/test/worktrees/feature/nested/branch",
        localCommit: "local123",
        remoteCommit: "remote456",
      });
      expect(savedMetadata.divergedAt).toBeDefined();
      expect(savedMetadata.instruction).toContain("git diff origin/feature/nested/branch");
    });
  });
});
