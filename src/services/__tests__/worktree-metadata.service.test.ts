import * as fs from "fs/promises";
import * as path from "path";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import simpleGit from "simple-git";

import { WorktreeMetadataService } from "../worktree-metadata.service";

import type { SyncMetadata } from "../../types/sync-metadata";
import type { SimpleGit } from "simple-git";

jest.mock("fs/promises");
jest.mock("simple-git");

describe("WorktreeMetadataService", () => {
  let service: WorktreeMetadataService;
  const mockBareRepoPath = "/test/bare/repo";
  const mockWorktreeName = "feature-branch";

  beforeEach(() => {
    jest.clearAllMocks();
    service = new WorktreeMetadataService();
  });

  describe("getMetadataPath", () => {
    it("should return correct metadata path", async () => {
      const metadataPath = await service.getMetadataPath(mockBareRepoPath, mockWorktreeName);
      expect(metadataPath).toBe("/test/bare/repo/.git/worktrees/feature-branch/sync-metadata.json");
    });

    it("should handle branch names with slashes correctly", async () => {
      // When a branch is named "fix/test-branch" and worktree is at "/worktrees/fix/test-branch"
      // Git stores internal metadata at .git/worktrees/test-branch/ (uses basename of path)
      // NOT at .git/worktrees/fix/test-branch/ (which would be a nested directory)
      const branchWithSlash = "fix/test-branch";
      const worktreePath = "/test/worktrees/fix/test-branch";

      // Current implementation (WRONG) - uses branch name directly
      const wrongPath = await service.getMetadataPath(mockBareRepoPath, branchWithSlash);
      expect(wrongPath).toBe("/test/bare/repo/.git/worktrees/fix/test-branch/sync-metadata.json");

      // This creates a nested directory structure that doesn't match Git's internal structure
      // Git would actually use: /test/bare/repo/.git/worktrees/test-branch/sync-metadata.json

      // Expected behavior: should use basename of worktree path
      const worktreeBasename = path.basename(worktreePath);
      const expectedPath = path.join(mockBareRepoPath, ".git", "worktrees", worktreeBasename, "sync-metadata.json");
      expect(expectedPath).toBe("/test/bare/repo/.git/worktrees/test-branch/sync-metadata.json");

      // This demonstrates the bug: wrongPath !== expectedPath
      expect(wrongPath).not.toBe(expectedPath);
    });

    it("should migrate metadata from old path to new path for branches with slashes", async () => {
      const worktreePath = "/test/worktrees/fix/test-branch";
      const oldMetadata = {
        lastSyncCommit: "abc123",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/fix/test-branch",
        createdFrom: { branch: "main", commit: "def456" },
        syncHistory: [],
      };

      // Mock readFile to fail for new path (doesn't exist yet) and succeed for old path
      (fs.readFile as jest.Mock<any>)
        .mockRejectedValueOnce(new Error("ENOENT")) // First try: new path doesn't exist
        .mockResolvedValueOnce(JSON.stringify(oldMetadata)); // Fallback: old path exists

      (fs.writeFile as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.unlink as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.rmdir as jest.Mock<any>).mockResolvedValue(undefined);

      const result = await service.loadMetadataFromPath(mockBareRepoPath, worktreePath);

      // Should have loaded from old path
      expect(result).toEqual(oldMetadata);

      // Should have migrated to new path (using basename)
      expect(fs.writeFile).toHaveBeenCalledWith(
        "/test/bare/repo/.git/worktrees/test-branch/sync-metadata.json",
        JSON.stringify(oldMetadata, null, 2),
        "utf-8",
      );

      // Should have cleaned up old path
      expect(fs.unlink).toHaveBeenCalledWith("/test/bare/repo/.git/worktrees/fix/test-branch/sync-metadata.json");
    });
  });

  describe("saveMetadata", () => {
    it("should save metadata to file", async () => {
      const mockMetadata: SyncMetadata = {
        lastSyncCommit: "abc123",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/feature-branch",
        createdFrom: {
          branch: "main",
          commit: "def456",
        },
        syncHistory: [
          {
            date: "2024-01-15T10:00:00Z",
            commit: "abc123",
            action: "created",
          },
        ],
      };

      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      await service.saveMetadata(mockBareRepoPath, mockWorktreeName, mockMetadata);

      expect(fs.mkdir).toHaveBeenCalledWith(
        path.dirname("/test/bare/repo/.git/worktrees/feature-branch/sync-metadata.json"),
        { recursive: true },
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        "/test/bare/repo/.git/worktrees/feature-branch/sync-metadata.json",
        JSON.stringify(mockMetadata, null, 2),
        "utf-8",
      );
    });
  });

  describe("loadMetadata", () => {
    it("should load metadata from file", async () => {
      const mockMetadata: SyncMetadata = {
        lastSyncCommit: "abc123",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/feature-branch",
        createdFrom: {
          branch: "main",
          commit: "def456",
        },
        syncHistory: [],
      };

      (fs.readFile as jest.Mock<any>).mockResolvedValue(JSON.stringify(mockMetadata));

      const result = await service.loadMetadata(mockBareRepoPath, mockWorktreeName);

      expect(fs.readFile).toHaveBeenCalledWith(
        "/test/bare/repo/.git/worktrees/feature-branch/sync-metadata.json",
        "utf-8",
      );
      expect(result).toEqual(mockMetadata);
    });

    it("should return null if file does not exist", async () => {
      (fs.readFile as jest.Mock<any>).mockRejectedValue(new Error("ENOENT"));

      const result = await service.loadMetadata(mockBareRepoPath, mockWorktreeName);

      expect(result).toBeNull();
    });

    it("should return null if file contains invalid JSON", async () => {
      (fs.readFile as jest.Mock<any>).mockResolvedValue("invalid json");

      const result = await service.loadMetadata(mockBareRepoPath, mockWorktreeName);

      expect(result).toBeNull();
    });
  });

  describe("deleteMetadata", () => {
    it("should delete metadata file", async () => {
      (fs.unlink as jest.Mock<any>).mockResolvedValue(undefined);

      await service.deleteMetadata(mockBareRepoPath, mockWorktreeName);

      expect(fs.unlink).toHaveBeenCalledWith("/test/bare/repo/.git/worktrees/feature-branch/sync-metadata.json");
    });

    it("should not throw if file does not exist", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      (fs.unlink as jest.Mock<any>).mockRejectedValue(error);

      await expect(service.deleteMetadata(mockBareRepoPath, mockWorktreeName)).resolves.not.toThrow();
    });

    it("should throw for other errors", async () => {
      const error = new Error("Permission denied");
      (fs.unlink as jest.Mock<any>).mockRejectedValue(error);

      await expect(service.deleteMetadata(mockBareRepoPath, mockWorktreeName)).rejects.toThrow("Permission denied");
    });
  });

  describe("updateLastSync", () => {
    it("should update existing metadata", async () => {
      const existingMetadata: SyncMetadata = {
        lastSyncCommit: "old123",
        lastSyncDate: "2024-01-14T10:00:00Z",
        upstreamBranch: "origin/feature-branch",
        createdFrom: {
          branch: "main",
          commit: "def456",
        },
        syncHistory: [
          {
            date: "2024-01-14T10:00:00Z",
            commit: "old123",
            action: "created",
          },
        ],
      };

      (fs.readFile as jest.Mock<any>).mockResolvedValue(JSON.stringify(existingMetadata));
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      // Mock Date to have consistent timestamps
      const mockDate = new Date("2024-01-15T12:00:00Z");
      const dateSpy = jest.spyOn(global, "Date").mockImplementation(() => mockDate as any);

      await service.updateLastSync(mockBareRepoPath, mockWorktreeName, "new456", "updated");

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"lastSyncCommit": "new456"'),
        "utf-8",
      );

      dateSpy.mockRestore();
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"lastSyncDate": "2024-01-15T12:00:00.000Z"'),
        "utf-8",
      );
    });

    it("should limit sync history to 10 entries", async () => {
      const existingMetadata: SyncMetadata = {
        lastSyncCommit: "old123",
        lastSyncDate: "2024-01-14T10:00:00Z",
        upstreamBranch: "origin/feature-branch",
        createdFrom: {
          branch: "main",
          commit: "def456",
        },
        syncHistory: Array(10).fill({
          date: "2024-01-01T10:00:00Z",
          commit: "old",
          action: "updated",
        }),
      };

      (fs.readFile as jest.Mock<any>).mockResolvedValue(JSON.stringify(existingMetadata));
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      await service.updateLastSync(mockBareRepoPath, mockWorktreeName, "new456", "updated");

      // Check that the saved metadata has exactly 10 entries
      const savedData = JSON.parse((fs.writeFile as jest.Mock<any>).mock.calls[0][1] as string);
      expect(savedData.syncHistory).toHaveLength(10);
      expect(savedData.syncHistory[9].commit).toBe("new456");
    });

    it("should warn if no metadata exists", async () => {
      (fs.readFile as jest.Mock<any>).mockRejectedValue(new Error("ENOENT"));
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

      await service.updateLastSync(mockBareRepoPath, mockWorktreeName, "new456");

      expect(consoleSpy).toHaveBeenCalledWith("No metadata found for worktree feature-branch, skipping update");
      expect(fs.writeFile).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe("createInitialMetadata", () => {
    it("should create initial metadata for new worktree", async () => {
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      const mockDate = new Date("2024-01-15T12:00:00Z");
      const dateSpy = jest.spyOn(global, "Date").mockImplementation(() => mockDate as any);

      await service.createInitialMetadata(
        mockBareRepoPath,
        mockWorktreeName,
        "abc123",
        "origin/feature-branch",
        "main",
        "def456",
      );

      dateSpy.mockRestore();

      const expectedMetadata: SyncMetadata = {
        lastSyncCommit: "abc123",
        lastSyncDate: "2024-01-15T12:00:00.000Z",
        upstreamBranch: "origin/feature-branch",
        createdFrom: {
          branch: "main",
          commit: "def456",
        },
        syncHistory: [
          {
            date: "2024-01-15T12:00:00.000Z",
            commit: "abc123",
            action: "created",
          },
        ],
      };

      expect(fs.writeFile).toHaveBeenCalledWith(
        "/test/bare/repo/.git/worktrees/feature-branch/sync-metadata.json",
        JSON.stringify(expectedMetadata, null, 2),
        "utf-8",
      );
    });
  });

  describe("validateMetadata", () => {
    it("should validate correct metadata", async () => {
      const validMetadata: SyncMetadata = {
        lastSyncCommit: "abc123def456",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/feature-branch",
        createdFrom: {
          branch: "main",
          commit: "def456",
        },
        syncHistory: [],
      };

      const isValid = await service.validateMetadata(validMetadata);
      expect(isValid).toBe(true);
    });

    it("should reject metadata with missing lastSyncCommit", async () => {
      const invalidMetadata = {
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/feature-branch",
        createdFrom: { branch: "main", commit: "def456" },
        syncHistory: [],
      } as any;

      const isValid = await service.validateMetadata(invalidMetadata);
      expect(isValid).toBe(false);
    });

    it("should reject metadata with missing lastSyncDate", async () => {
      const invalidMetadata = {
        lastSyncCommit: "abc123",
        upstreamBranch: "origin/feature-branch",
        createdFrom: { branch: "main", commit: "def456" },
        syncHistory: [],
      } as any;

      const isValid = await service.validateMetadata(invalidMetadata);
      expect(isValid).toBe(false);
    });

    it("should reject metadata with missing upstreamBranch", async () => {
      const invalidMetadata = {
        lastSyncCommit: "abc123",
        lastSyncDate: "2024-01-15T10:00:00Z",
        createdFrom: { branch: "main", commit: "def456" },
        syncHistory: [],
      } as any;

      const isValid = await service.validateMetadata(invalidMetadata);
      expect(isValid).toBe(false);
    });

    it("should reject metadata with non-hex commit hash", async () => {
      const invalidMetadata: SyncMetadata = {
        lastSyncCommit: "not-a-hex-value",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/feature-branch",
        createdFrom: { branch: "main", commit: "def456" },
        syncHistory: [],
      };

      const isValid = await service.validateMetadata(invalidMetadata);
      expect(isValid).toBe(false);
    });

    it("should reject metadata with invalid date", async () => {
      const invalidMetadata: SyncMetadata = {
        lastSyncCommit: "abc123",
        lastSyncDate: "not-a-date",
        upstreamBranch: "origin/feature-branch",
        createdFrom: { branch: "main", commit: "def456" },
        syncHistory: [],
      };

      const isValid = await service.validateMetadata(invalidMetadata);
      expect(isValid).toBe(false);
    });

    it("should accept short commit hashes", async () => {
      const validMetadata: SyncMetadata = {
        lastSyncCommit: "abc123",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/feature-branch",
        createdFrom: { branch: "main", commit: "def456" },
        syncHistory: [],
      };

      const isValid = await service.validateMetadata(validMetadata);
      expect(isValid).toBe(true);
    });
  });

  describe("loadMetadataFromPath validation", () => {
    it("should return null when metadata is corrupted", async () => {
      const corruptedMetadata = {
        lastSyncCommit: "not-hex",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/feature",
      };

      (fs.readFile as jest.Mock<any>).mockResolvedValue(JSON.stringify(corruptedMetadata));
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

      const result = await service.loadMetadataFromPath(mockBareRepoPath, "/test/worktrees/feature");

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Corrupted metadata for /test/worktrees/feature"),
      );

      consoleSpy.mockRestore();
    });

    it("should migrate and validate metadata from old path", async () => {
      const validMetadata: SyncMetadata = {
        lastSyncCommit: "abc123",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/fix/test-branch",
        createdFrom: { branch: "main", commit: "def456" },
        syncHistory: [],
      };

      (fs.readFile as jest.Mock<any>)
        .mockRejectedValueOnce(new Error("ENOENT"))
        .mockResolvedValueOnce(JSON.stringify(validMetadata));

      (fs.writeFile as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.unlink as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.rmdir as jest.Mock<any>).mockResolvedValue(undefined);

      const result = await service.loadMetadataFromPath(mockBareRepoPath, "/test/worktrees/fix/test-branch");

      expect(result).toEqual(validMetadata);
    });

    it("should return null when old path metadata is corrupted", async () => {
      const corruptedMetadata = {
        lastSyncCommit: "invalid-hash!@#",
        lastSyncDate: "2024-01-15T10:00:00Z",
        upstreamBranch: "origin/fix/test",
      };

      (fs.readFile as jest.Mock<any>)
        .mockRejectedValueOnce(new Error("ENOENT"))
        .mockResolvedValueOnce(JSON.stringify(corruptedMetadata));

      const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

      const result = await service.loadMetadataFromPath(mockBareRepoPath, "/test/worktrees/fix/test-branch");

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Corrupted metadata at old path"));

      consoleSpy.mockRestore();
    });
  });

  describe("updateLastSyncFromPath auto-repair", () => {
    let mockGit: jest.Mocked<SimpleGit>;

    beforeEach(() => {
      mockGit = {
        revparse: jest.fn<any>().mockResolvedValue("abc123def456"),
      } as any;

      (simpleGit as unknown as jest.Mock).mockReturnValue(mockGit);
    });

    it("should create metadata when missing", async () => {
      const worktreePath = "/test/worktrees/feature-branch";

      (fs.readFile as jest.Mock<any>).mockRejectedValue(new Error("ENOENT"));
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      mockGit.branch = jest.fn<any>().mockResolvedValue({
        current: "feature-branch",
        all: ["feature-branch"],
        branches: {},
      });
      mockGit.raw = jest.fn<any>().mockRejectedValue(new Error("fatal: no upstream configured"));

      const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      await service.updateLastSyncFromPath(mockBareRepoPath, worktreePath, "new123");

      expect(consoleSpy).toHaveBeenCalledWith("No metadata found for worktree feature-branch");
      expect(logSpy).toHaveBeenCalledWith("  Attempting to create initial metadata...");
      expect(logSpy).toHaveBeenCalledWith("  ✅ Created metadata for feature-branch");
      expect(mockGit.revparse).toHaveBeenCalledWith(["HEAD"]);
      expect(mockGit.branch).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();

      consoleSpy.mockRestore();
      logSpy.mockRestore();
    });

    it("should throw error when auto-repair fails", async () => {
      const worktreePath = "/test/worktrees/feature-branch";
      const revparseError = new Error("fatal: not a git repository");

      (fs.readFile as jest.Mock<any>).mockRejectedValue(new Error("ENOENT"));
      mockGit.revparse.mockRejectedValue(revparseError);

      const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      await expect(service.updateLastSyncFromPath(mockBareRepoPath, worktreePath, "new123")).rejects.toThrow(
        "fatal: not a git repository",
      );

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("❌ Failed to create metadata"));

      consoleSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("should use correct branch name for upstream with branches containing slashes", async () => {
      const worktreePath = "/test/worktrees/feature/foo";
      const currentCommit = "abc123def456";

      (fs.readFile as jest.Mock<any>).mockRejectedValue(new Error("ENOENT"));
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      mockGit.revparse.mockResolvedValue(currentCommit);
      mockGit.branch = jest.fn<any>().mockResolvedValue({
        current: "feature/foo",
        all: ["feature/foo"],
        branches: {},
      });
      mockGit.raw = jest.fn<any>().mockRejectedValue(new Error("fatal: no upstream configured"));

      const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      await service.updateLastSyncFromPath(mockBareRepoPath, worktreePath, currentCommit);

      const writeCallArg = (fs.writeFile as jest.Mock<any>).mock.calls[0][1] as string;
      const savedMetadata = JSON.parse(writeCallArg);

      // Now fixed: uses actual branch name from git branch command
      // - Old code used `origin/${worktreeDirName}` which was "origin/foo" (basename)
      // - New code uses actual branch name: "origin/feature/foo"
      expect(savedMetadata.upstreamBranch).toBe("origin/feature/foo");

      consoleSpy.mockRestore();
      logSpy.mockRestore();
    });

    it("should use actual default branch instead of hard-coded 'main'", async () => {
      const worktreePath = "/test/worktrees/feature-branch";
      const currentCommit = "abc123def456";

      (fs.readFile as jest.Mock<any>).mockRejectedValue(new Error("ENOENT"));
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      mockGit.revparse.mockResolvedValue(currentCommit);
      mockGit.branch = jest.fn<any>().mockResolvedValue({
        current: "feature-branch",
        all: ["feature-branch"],
        branches: {},
      });
      mockGit.raw = jest.fn<any>().mockRejectedValue(new Error("fatal: no upstream configured"));

      const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      // Test with a non-"main" default branch
      await service.updateLastSyncFromPath(mockBareRepoPath, worktreePath, currentCommit, "updated", "develop");

      const writeCallArg = (fs.writeFile as jest.Mock<any>).mock.calls[0][1] as string;
      const savedMetadata = JSON.parse(writeCallArg);

      // Now fixed: uses passed default branch instead of hard-coded "main"
      expect(savedMetadata.createdFrom.branch).toBe("develop");

      consoleSpy.mockRestore();
      logSpy.mockRestore();
    });
  });

  describe("updateLastSync", () => {
    it("should update existing metadata when present", async () => {
      const existingMetadata: SyncMetadata = {
        lastSyncCommit: "old123",
        lastSyncDate: "2024-01-14T10:00:00Z",
        upstreamBranch: "origin/feature-branch",
        createdFrom: { branch: "main", commit: "def456" },
        syncHistory: [],
      };

      (fs.readFile as jest.Mock<any>).mockResolvedValue(JSON.stringify(existingMetadata));
      (fs.mkdir as jest.Mock<any>).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock<any>).mockResolvedValue(undefined);

      await service.updateLastSync(mockBareRepoPath, mockWorktreeName, "new123", "updated");

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"lastSyncCommit": "new123"'),
        "utf-8",
      );
    });
  });
});
