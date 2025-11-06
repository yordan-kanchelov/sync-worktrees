import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { calculateDirectorySize, calculateSyncDiskSpace, formatBytes } from "../disk-space";

describe("disk-space", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "disk-space-test-"));
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
      const size = await calculateDirectorySize(path.join(tempDir, "nonexistent"));
      expect(size).toBe(0);
    });

    it("should return size for a single file", async () => {
      const filePath = path.join(tempDir, "test.txt");
      const content = "Hello, World!";
      await fs.promises.writeFile(filePath, content);

      const size = await calculateDirectorySize(filePath);
      expect(size).toBe(Buffer.byteLength(content));
    });

    it("should calculate size of empty directory", async () => {
      const emptyDir = path.join(tempDir, "empty");
      await fs.promises.mkdir(emptyDir);

      const size = await calculateDirectorySize(emptyDir);
      expect(size).toBe(0);
    });

    it("should calculate size of directory with files", async () => {
      const dir = path.join(tempDir, "with-files");
      await fs.promises.mkdir(dir);

      const file1Content = "File 1 content";
      const file2Content = "File 2 content longer";

      await fs.promises.writeFile(path.join(dir, "file1.txt"), file1Content);
      await fs.promises.writeFile(path.join(dir, "file2.txt"), file2Content);

      const size = await calculateDirectorySize(dir);
      const expectedSize = Buffer.byteLength(file1Content) + Buffer.byteLength(file2Content);

      expect(size).toBe(expectedSize);
    });

    it("should calculate size recursively for nested directories", async () => {
      const parentDir = path.join(tempDir, "parent");
      const childDir = path.join(parentDir, "child");

      await fs.promises.mkdir(parentDir);
      await fs.promises.mkdir(childDir);

      const parentFileContent = "Parent file";
      const childFileContent = "Child file content";

      await fs.promises.writeFile(path.join(parentDir, "parent.txt"), parentFileContent);
      await fs.promises.writeFile(path.join(childDir, "child.txt"), childFileContent);

      const size = await calculateDirectorySize(parentDir);
      const expectedSize = Buffer.byteLength(parentFileContent) + Buffer.byteLength(childFileContent);

      expect(size).toBe(expectedSize);
    });

    it("should handle multiple nested levels", async () => {
      const level1 = path.join(tempDir, "level1");
      const level2 = path.join(level1, "level2");
      const level3 = path.join(level2, "level3");

      await fs.promises.mkdir(level1);
      await fs.promises.mkdir(level2);
      await fs.promises.mkdir(level3);

      await fs.promises.writeFile(path.join(level1, "file1.txt"), "A");
      await fs.promises.writeFile(path.join(level2, "file2.txt"), "BB");
      await fs.promises.writeFile(path.join(level3, "file3.txt"), "CCC");

      const size = await calculateDirectorySize(level1);
      expect(size).toBe(6); // 1 + 2 + 3 bytes
    });

    it("should skip broken symlinks gracefully", async () => {
      const dir = path.join(tempDir, "with-symlink");
      await fs.promises.mkdir(dir);

      const validFile = path.join(dir, "valid.txt");
      await fs.promises.writeFile(validFile, "Valid content");

      // Create a broken symlink
      const symlinkPath = path.join(dir, "broken-symlink");
      const nonExistentTarget = path.join(tempDir, "nonexistent");
      await fs.promises.symlink(nonExistentTarget, symlinkPath);

      const size = await calculateDirectorySize(dir);
      expect(size).toBe(Buffer.byteLength("Valid content"));
    });
  });

  describe("calculateSyncDiskSpace", () => {
    it("should return N/A for empty arrays", async () => {
      const result = await calculateSyncDiskSpace([], []);
      expect(result).toBe("0 B");
    });

    it("should calculate total size for .bare directories", async () => {
      const repoPath = path.join(tempDir, "repo");
      const barePath = path.join(repoPath, ".bare");

      await fs.promises.mkdir(repoPath, { recursive: true });
      await fs.promises.mkdir(barePath);

      await fs.promises.writeFile(path.join(barePath, "config"), "git config content");

      const result = await calculateSyncDiskSpace([repoPath], []);
      expect(result).not.toBe("N/A");
      expect(result).not.toBe("0 B");
    });

    it("should calculate total size for worktree directories", async () => {
      const worktreeDir = path.join(tempDir, "worktrees");
      const branch1 = path.join(worktreeDir, "branch1");

      await fs.promises.mkdir(branch1, { recursive: true });
      await fs.promises.writeFile(path.join(branch1, "file.txt"), "worktree content");

      const result = await calculateSyncDiskSpace([], [worktreeDir]);
      expect(result).not.toBe("N/A");
      expect(result).not.toBe("0 B");
    });

    it("should calculate combined size of .bare and worktree directories", async () => {
      const repoPath = path.join(tempDir, "repo");
      const barePath = path.join(repoPath, ".bare");
      const worktreeDir = path.join(tempDir, "worktrees");

      await fs.promises.mkdir(barePath, { recursive: true });
      await fs.promises.mkdir(worktreeDir, { recursive: true });

      const bareContent = "bare content";
      const worktreeContent = "worktree content";

      await fs.promises.writeFile(path.join(barePath, "config"), bareContent);
      await fs.promises.writeFile(path.join(worktreeDir, "file.txt"), worktreeContent);

      const result = await calculateSyncDiskSpace([barePath], [worktreeDir]);

      // The total size should be the sum of both contents
      const expectedBytes = Buffer.byteLength(bareContent) + Buffer.byteLength(worktreeContent);

      expect(result).toBe(formatBytes(expectedBytes));
    });

    it("should handle multiple repositories and worktree directories", async () => {
      const bare1Path = path.join(tempDir, ".bare", "repo1");
      const bare2Path = path.join(tempDir, ".bare", "repo2");
      const worktree1Dir = path.join(tempDir, "worktrees1");
      const worktree2Dir = path.join(tempDir, "worktrees2");

      await fs.promises.mkdir(bare1Path, { recursive: true });
      await fs.promises.mkdir(bare2Path, { recursive: true });
      await fs.promises.mkdir(worktree1Dir, { recursive: true });
      await fs.promises.mkdir(worktree2Dir, { recursive: true });

      await fs.promises.writeFile(path.join(bare1Path, "file"), "A");
      await fs.promises.writeFile(path.join(bare2Path, "file"), "BB");
      await fs.promises.writeFile(path.join(worktree1Dir, "file"), "CCC");
      await fs.promises.writeFile(path.join(worktree2Dir, "file"), "DDDD");

      const result = await calculateSyncDiskSpace([bare1Path, bare2Path], [worktree1Dir, worktree2Dir]);

      expect(result).toBe(formatBytes(10)); // 1 + 2 + 3 + 4 = 10 bytes
    });

    it("should gracefully handle non-existent bare repository directories", async () => {
      const bareRepoPath = path.join(tempDir, "nonexistent-bare");

      const result = await calculateSyncDiskSpace([bareRepoPath], []);
      expect(result).toBe("0 B");
    });

    it("should gracefully handle non-existent worktree directories", async () => {
      const result = await calculateSyncDiskSpace([], [path.join(tempDir, "nonexistent")]);
      expect(result).toBe("0 B");
    });
  });
});
