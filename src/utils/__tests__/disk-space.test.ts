import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import pLimit from "p-limit";
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
    it("should reject for non-existent directory", async () => {
      const fastFolderSize = (await import("fast-folder-size")).default;
      vi.mocked(fastFolderSize).mockImplementationOnce((_path: string, callback: any) => {
        callback(new Error("ENOENT"));
        return {} as any;
      });

      await expect(calculateDirectorySize(path.join(tempDir, "nonexistent"))).rejects.toThrow("ENOENT");
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

    it("should reject when fastFolderSize returns undefined bytes", async () => {
      const fastFolderSize = (await import("fast-folder-size")).default;
      vi.mocked(fastFolderSize).mockImplementationOnce((_path: string, callback: any) => {
        callback(null, undefined);
        return {} as any;
      });

      await expect(calculateDirectorySize(tempDir)).rejects.toThrow("returned no bytes");
    });

    it("should reject on errors", async () => {
      const fastFolderSize = (await import("fast-folder-size")).default;
      vi.mocked(fastFolderSize).mockImplementationOnce((_path: string, callback: any) => {
        callback(new Error("Permission denied"));
        return {} as any;
      });

      await expect(calculateDirectorySize(tempDir)).rejects.toThrow("Permission denied");
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

    it("hands every directory to `measure` at once, so the bound is the caller's", async () => {
      // This function does not bound anything, and this pins that rather than
      // claiming otherwise: it fans `repoPaths.concat(worktreeDirs)` into one
      // `Promise.all`, so N directories means N simultaneous calls to whatever
      // `measure` it was given. The shipped caller passes DiskUsageCache's
      // bounded measure -- see the second half of this test, and
      // "bounds the disk walks by the repository parallelism it was given" in
      // interactive-ui.status-fanout-and-disk.test.ts for the real caller.
      let inFlight = 0;
      let peak = 0;
      const release: Array<() => void> = [];

      const total = calculateSyncDiskSpace(["/bare-a", "/bare-b"], ["/wt-a", "/wt-b"], () => {
        // Recorded from inside the walk: what actually overlapped, not what the
        // caller was handed.
        inFlight += 1;
        if (inFlight > peak) peak = inFlight;
        return new Promise<number>((resolve) => {
          release.push(() => {
            inFlight -= 1;
            resolve(256);
          });
        });
      });

      for (let tick = 0; tick < 4; tick++) await Promise.resolve();
      expect(peak).toBe(4);

      for (const done of release) done();
      expect(await total).toBe("1.00 KB");
    });

    it("overlaps exactly as far as the measure it is given allows", async () => {
      // The same four directories through a measure that bounds itself at two,
      // which is what `DiskUsageCache(2)` does for the shipped caller. Measured
      // on a 197 MB, 50,407-path six-directory workspace: 101 ms in sequence,
      // 48 ms through that bound, 29 ms unbounded.
      const limit = pLimit(2);
      let inFlight = 0;
      let peak = 0;

      const total = await calculateSyncDiskSpace(["/bare-a", "/bare-b"], ["/wt-a", "/wt-b"], (dirPath) =>
        limit(async () => {
          inFlight += 1;
          if (inFlight > peak) peak = inFlight;
          await Promise.resolve();
          inFlight -= 1;
          return dirPath.length > 0 ? 256 : 0;
        }),
      );

      expect(peak).toBe(2);
      expect(total).toBe("1.00 KB");
    });

    it("uses the measure it is given, so a caller can cache the walks", async () => {
      const fastFolderSize = (await import("fast-folder-size")).default;
      const walked: string[] = [];

      const result = await calculateSyncDiskSpace(["/bare-a"], ["/wt-a"], (dirPath) => {
        walked.push(dirPath);
        return Promise.resolve(512);
      });

      expect(walked).toEqual(["/bare-a", "/wt-a"]);
      expect(result).toBe("1.00 KB");
      expect(vi.mocked(fastFolderSize)).not.toHaveBeenCalled();
    });

    // The caller owns reporting: writing to the console here would land on
    // top of the TUI's Ink frame.
    it("rejects, without writing to the console, when measure throws synchronously", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(
        calculateSyncDiskSpace(["/bare-a"], [], () => {
          throw new Error("measure blew up");
        }),
      ).rejects.toThrow("measure blew up");

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});
