import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PathResolutionService } from "../path-resolution.service";

describe("PathResolutionService", () => {
  let service: PathResolutionService;

  beforeEach(() => {
    service = new PathResolutionService();
  });

  describe("sanitizeBranchName", () => {
    it("should start sanitized output with readable branch stem", () => {
      expect(service.sanitizeBranchName("feature/test")).toMatch(/^feature-test-[a-f0-9]{8}$/);
    });

    it("should replace special characters with underscores in readable stem", () => {
      expect(service.sanitizeBranchName("bug#123")).toMatch(/^bug_123-[a-f0-9]{8}$/);
      expect(service.sanitizeBranchName("user@domain")).toMatch(/^user_domain-[a-f0-9]{8}$/);
    });

    it("should handle complex branch names", () => {
      expect(service.sanitizeBranchName("feature/bug#123@hotfix")).toMatch(/^feature-bug_123_hotfix-[a-f0-9]{8}$/);
    });

    it("should preserve alphanumeric and basic characters in stem", () => {
      expect(service.sanitizeBranchName("feat-123_test")).toMatch(/^feat-123_test-[a-f0-9]{8}$/);
    });

    it("should produce different outputs for collision-prone branch names", () => {
      const a = service.sanitizeBranchName("feature/test");
      const b = service.sanitizeBranchName("feature-test");
      expect(a).not.toBe(b);
    });

    it("should be deterministic for the same input", () => {
      expect(service.sanitizeBranchName("feature/test")).toBe(service.sanitizeBranchName("feature/test"));
    });
  });

  describe("isPathInsideBaseDir", () => {
    it("should return true for path inside base directory", () => {
      expect(service.isPathInsideBaseDir("/base/sub/path", "/base")).toBe(true);
    });

    it("should return false for path outside base directory", () => {
      expect(service.isPathInsideBaseDir("/outside", "/base")).toBe(false);
    });

    it("should return false for path traversal attempts", () => {
      expect(service.isPathInsideBaseDir("/base/../outside", "/base")).toBe(false);
    });

    it("should return false for a deep traversal escape", () => {
      expect(service.isPathInsideBaseDir("/base/worktrees/../../etc/passwd", "/base/worktrees")).toBe(false);
    });

    it("should return true when path equals base directory", () => {
      expect(service.isPathInsideBaseDir("/base", "/base")).toBe(true);
    });
  });

  describe("symlink boundary", () => {
    let tmpRoot: string;
    let baseDir: string;
    let outsideDir: string;
    let symlinkInsideBase: string;
    let symlinkSupported = true;

    beforeAll(async () => {
      tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "path-res-")));
      baseDir = path.join(tmpRoot, "base");
      outsideDir = path.join(tmpRoot, "outside");
      await fs.mkdir(baseDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      symlinkInsideBase = path.join(baseDir, "escape");
      try {
        await fs.symlink(outsideDir, symlinkInsideBase, "dir");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // Environments without symlink privileges return EPERM/EACCES/UNKNOWN/ENOSYS.
        if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN" || code === "ENOSYS") {
          symlinkSupported = false;
          return;
        }
        throw err;
      }
    });

    afterAll(async () => {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    it("isPathInsideBaseDir should return false for symlink escaping base", () => {
      if (!symlinkSupported) return;
      const target = path.join(symlinkInsideBase, "child");
      expect(service.isPathInsideBaseDir(target, baseDir)).toBe(false);
    });
  });
});
