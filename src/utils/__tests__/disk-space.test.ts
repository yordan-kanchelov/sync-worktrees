import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { calculateDirectorySize, calculateSyncDiskSpace, formatBytes } from "../disk-space";

vi.mock("fast-folder-size", () => ({
  default: vi.fn(),
}));

describe("disk-space", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "disk-space-test-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe("formatBytes", () => {
    it("should format 0 bytes correctly", () => {
      expect(formatBytes(0)).toBe("0 B");
    });

    it("should format bytes correctly", () => {
      expect(formatBytes(500)).toBe("500.00 B");
    });

    it("should format kilobytes correctly", () => {
      expect(formatBytes(1024)).toBe("1.00 KB");
      expect(formatBytes(1536)).toBe("1.50 KB");
    });

    it("should format megabytes correctly", () => {
      expect(formatBytes(1024 * 1024)).toBe("1.00 MB");
      expect(formatBytes(1024 * 1024 * 1.5)).toBe("1.50 MB");
    });

    it("should format gigabytes correctly", () => {
      expect(formatBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
      expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe("2.50 GB");
    });

    it("should format terabytes correctly", () => {
      expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe("1.00 TB");
    });
  });

  describe("calculateDirectorySize", () => {
    it("should return 0 for non-existent directory", async () => {
      const fastFolderSize = (await import("fast-folder-size")).default;
      vi.mocked(fastFolderSize).mockImplementationOnce((_path: string, callback: any) => {
        callback(new Error("ENOENT"));
        return {} as any;
      });

      const size = await calculateDirectorySize(path.join(tempDir, "nonexistent"));
      expect(size).toBe(0);
    });

    it("should return size for a directory", async () => {
      const fastFolderSize = (await import("fast-folder-size")).default;
      vi.mocked(fastFolderSize).mockImplementationOnce((_path: string, callback: any) => {
        callback(null, 1024);
        return {} as any;
      });

      const size = await calculateDirectorySize(tempDir);
      expect(size).toBe(1024);
    });

    it("should return 0 for empty directory", async () => {
      const fastFolderSize = (await import("fast-folder-size")).default;
      vi.mocked(fastFolderSize).mockImplementationOnce((_path: string, callback: any) => {
        callback(null, 0);
        return {} as any;
      });

      const emptyDir = path.join(tempDir, "empty");
      await fs.promises.mkdir(emptyDir);

      const size = await calculateDirectorySize(emptyDir);
      expect(size).toBe(0);
    });

    it("should handle undefined bytes from fastFolderSize", async () => {
      const fastFolderSize = (await import("fast-folder-size")).default;
      vi.mocked(fastFolderSize).mockImplementationOnce((_path: string, callback: any) => {
        callback(null, undefined);
        return {} as any;
      });

      const size = await calculateDirectorySize(tempDir);
      expect(size).toBe(0);
    });

    it("should handle errors gracefully", async () => {
      const fastFolderSize = (await import("fast-folder-size")).default;
      vi.mocked(fastFolderSize).mockImplementationOnce((_path: string, callback: any) => {
        callback(new Error("Permission denied"));
        return {} as any;
      });

      const size = await calculateDirectorySize(tempDir);
      expect(size).toBe(0);
    });
  });

  describe("calculateSyncDiskSpace", () => {
    it("should return 0 B for empty arrays", async () => {
      const result = await calculateSyncDiskSpace([], []);
      expect(result).toBe("0 B");
    });

    it("should calculate total size for bare directories", async () => {
      const fastFolderSize = (await import("fast-folder-size")).default;
      const repoPath = path.join(tempDir, "repo");

      vi.mocked(fastFolderSize).mockImplementationOnce((_path: string, callback: any) => {
        callback(null, 1024 * 1024);
        return {} as any;
      });

      const result = await calculateSyncDiskSpace([repoPath], []);
      expect(result).toBe("1.00 MB");
    });

    it("should calculate total size for worktree directories", async () => {
      const fastFolderSize = (await import("fast-folder-size")).default;
      const worktreeDir = path.join(tempDir, "worktrees");

      vi.mocked(fastFolderSize).mockImplementationOnce((_path: string, callback: any) => {
        callback(null, 512 * 1024);
        return {} as any;
      });

      const result = await calculateSyncDiskSpace([], [worktreeDir]);
      expect(result).toBe("512.00 KB");
    });

    it("should calculate combined size of bare and worktree directories", async () => {
      const fastFolderSize = (await import("fast-folder-size")).default;
      const barePath = path.join(tempDir, ".bare");
      const worktreeDir = path.join(tempDir, "worktrees");

      let callCount = 0;
      vi.mocked(fastFolderSize).mockImplementation((_path: string, callback: any) => {
        callCount++;
        if (callCount === 1) {
          callback(null, 1024);
        } else {
          callback(null, 2048);
        }
        return {} as any;
      });

      const result = await calculateSyncDiskSpace([barePath], [worktreeDir]);
      expect(result).toBe(formatBytes(3072));
    });

    it("should handle multiple repositories and worktree directories", async () => {
      const fastFolderSize = (await import("fast-folder-size")).default;
      const bare1Path = path.join(tempDir, ".bare", "repo1");
      const bare2Path = path.join(tempDir, ".bare", "repo2");
      const worktree1Dir = path.join(tempDir, "worktrees1");
      const worktree2Dir = path.join(tempDir, "worktrees2");

      const sizes = [1, 2, 3, 4];
      let callIndex = 0;
      vi.mocked(fastFolderSize).mockImplementation((_path: string, callback: any) => {
        callback(null, sizes[callIndex++]);
        return {} as any;
      });

      const result = await calculateSyncDiskSpace([bare1Path, bare2Path], [worktree1Dir, worktree2Dir]);
      expect(result).toBe(formatBytes(10));
    });

    it("should gracefully handle non-existent directories", async () => {
      const fastFolderSize = (await import("fast-folder-size")).default;
      vi.mocked(fastFolderSize).mockImplementation((_path: string, callback: any) => {
        callback(new Error("ENOENT"));
        return {} as any;
      });

      const result = await calculateSyncDiskSpace([path.join(tempDir, "nonexistent")], []);
      expect(result).toBe("0 B");
    });

    it("should handle mixed success and failure", async () => {
      const fastFolderSize = (await import("fast-folder-size")).default;
      const path1 = path.join(tempDir, "exists");
      const path2 = path.join(tempDir, "missing");

      let callCount = 0;
      vi.mocked(fastFolderSize).mockImplementation((_path: string, callback: any) => {
        callCount++;
        if (callCount === 1) {
          callback(null, 1024);
        } else {
          callback(new Error("ENOENT"));
        }
        return {} as any;
      });

      const result = await calculateSyncDiskSpace([path1, path2], []);
      expect(result).toBe("1.00 KB");
    });
  });
});
