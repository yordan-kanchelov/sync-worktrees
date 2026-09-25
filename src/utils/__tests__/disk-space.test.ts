import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import pLimit from "p-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { calculateDirectorySize, calculateSyncDiskSpace, formatBytes } from "../disk-space";

import type * as ChildProcessModule from "child_process";

// The real `execFile` unless a test scripts `du`'s answers with `duAnswers`,
// so the same file covers both the parsing and a real `du` run.
vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcessModule>("child_process");
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

// Answers successive `du` calls in order: a string is its stdout, an Error its
// failure. Calls come in the order `calculateSyncDiskSpace` makes them.
function duAnswers(...answers: Array<string | Error>): void {
  vi.mocked(execFile).mockImplementation(((_file: string, _args: readonly string[], callback: ExecFileCallback) => {
    const answer = answers.shift() ?? new Error("unexpected du call");
    if (answer instanceof Error) callback(answer, "", "");
    else callback(null, answer, "");
    return {} as ChildProcessModule.ChildProcess;
  }) as unknown as typeof execFile);
}

describe("disk-space", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "disk-space-test-"));
    vi.mocked(execFile).mockReset();
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
    it("runs `du -sk` on the path, without a shell, and converts KiB to bytes", async () => {
      duAnswers(`12\t${tempDir}\n`);

      await expect(calculateDirectorySize(tempDir)).resolves.toBe(12 * 1024);
      expect(vi.mocked(execFile)).toHaveBeenCalledWith("du", ["-sk", "--", tempDir], expect.any(Function));
    });

    it("measures a real directory with the system du", async () => {
      // A name a shell would expand: proves the path reaches `du` as one argument.
      const dir = path.join(tempDir, "with space $(touch pwned)");
      await fs.promises.mkdir(dir);
      await fs.promises.writeFile(path.join(dir, "data.bin"), Buffer.alloc(64 * 1024, 1));

      const size = await calculateDirectorySize(dir);

      expect(size).toBeGreaterThanOrEqual(64 * 1024);
      expect(size % 1024).toBe(0);
      expect(fs.existsSync(path.join(process.cwd(), "pwned"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "pwned"))).toBe(false);
    });

    it("should reject for non-existent directory", async () => {
      await expect(calculateDirectorySize(path.join(tempDir, "nonexistent"))).rejects.toThrow();
    });

    it("should return 0 when du reports 0", async () => {
      duAnswers(`0\t${tempDir}\n`);

      await expect(calculateDirectorySize(tempDir)).resolves.toBe(0);
    });

    it("should reject when du prints no size", async () => {
      duAnswers("");

      await expect(calculateDirectorySize(tempDir)).rejects.toThrow("du printed no size");
    });

    it("should reject on errors", async () => {
      duAnswers(new Error("Permission denied"));

      await expect(calculateDirectorySize(tempDir)).rejects.toThrow("Permission denied");
    });
  });

  describe("calculateSyncDiskSpace", () => {
    it("should return 0 B for empty arrays", async () => {
      const result = await calculateSyncDiskSpace([], []);
      expect(result).toBe("0 B");
    });

    it("should calculate total size for bare directories", async () => {
      const repoPath = path.join(tempDir, "repo");
      duAnswers(`1024\t${repoPath}\n`);

      const result = await calculateSyncDiskSpace([repoPath], []);
      expect(result).toBe("1.00 MB");
    });

    it("should calculate total size for worktree directories", async () => {
      const worktreeDir = path.join(tempDir, "worktrees");
      duAnswers(`512\t${worktreeDir}\n`);

      const result = await calculateSyncDiskSpace([], [worktreeDir]);
      expect(result).toBe("512.00 KB");
    });

    it("should calculate combined size of bare and worktree directories", async () => {
      const barePath = path.join(tempDir, ".bare");
      const worktreeDir = path.join(tempDir, "worktrees");
      duAnswers(`1\t${barePath}\n`, `2\t${worktreeDir}\n`);

      const result = await calculateSyncDiskSpace([barePath], [worktreeDir]);
      expect(result).toBe(formatBytes(3072));
    });

    it("should handle multiple repositories and worktree directories", async () => {
      const bare1Path = path.join(tempDir, ".bare", "repo1");
      const bare2Path = path.join(tempDir, ".bare", "repo2");
      const worktree1Dir = path.join(tempDir, "worktrees1");
      const worktree2Dir = path.join(tempDir, "worktrees2");
      duAnswers("1\ta\n", "2\tb\n", "3\tc\n", "4\td\n");

      const result = await calculateSyncDiskSpace([bare1Path, bare2Path], [worktree1Dir, worktree2Dir]);
      expect(result).toBe(formatBytes(10 * 1024));
    });

    it("should gracefully handle non-existent directories", async () => {
      // The real `du`, on a path that is not there.
      const result = await calculateSyncDiskSpace([path.join(tempDir, "nonexistent")], []);
      expect(result).toBe("0 B");
    });

    it("should handle mixed success and failure", async () => {
      const path1 = path.join(tempDir, "exists");
      const path2 = path.join(tempDir, "missing");
      duAnswers(`1\t${path1}\n`, new Error("ENOENT"));

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
      const walked: string[] = [];

      const result = await calculateSyncDiskSpace(["/bare-a"], ["/wt-a"], (dirPath) => {
        walked.push(dirPath);
        return Promise.resolve(512);
      });

      expect(walked).toEqual(["/bare-a", "/wt-a"]);
      expect(result).toBe("1.00 KB");
      expect(vi.mocked(execFile)).not.toHaveBeenCalled();
    });
  });
});
