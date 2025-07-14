import * as fs from "fs/promises";
import * as path from "path";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { WorktreeMetadataService } from "../worktree-metadata.service";

import type { SyncMetadata } from "../../types/sync-metadata";

jest.mock("fs/promises");

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
      jest.spyOn(global, "Date").mockImplementation(() => mockDate as any);

      await service.updateLastSync(mockBareRepoPath, mockWorktreeName, "new456", "updated");

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"lastSyncCommit": "new456"'),
        "utf-8",
      );
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
      jest.spyOn(global, "Date").mockImplementation(() => mockDate as any);

      await service.createInitialMetadata(
        mockBareRepoPath,
        mockWorktreeName,
        "abc123",
        "origin/feature-branch",
        "main",
        "def456",
      );

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
});
