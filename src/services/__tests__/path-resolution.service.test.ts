import * as path from "path";

import { describe, expect, it } from "@jest/globals";

import { PathResolutionService } from "../path-resolution.service";

describe("PathResolutionService", () => {
  let service: PathResolutionService;

  beforeEach(() => {
    service = new PathResolutionService();
  });

  describe("toAbsolute", () => {
    it("should convert relative path to absolute", () => {
      const result = service.toAbsolute("./test");
      expect(path.isAbsolute(result)).toBe(true);
      expect(result).toContain("test");
    });

    it("should return absolute path unchanged", () => {
      const absolutePath = "/absolute/path";
      const result = service.toAbsolute(absolutePath);
      expect(result).toBe(absolutePath);
    });
  });

  describe("toAbsoluteFrom", () => {
    it("should resolve relative path from base path", () => {
      const basePath = "/base/path";
      const relativePath = "./relative";
      const result = service.toAbsoluteFrom(relativePath, basePath);
      expect(result).toBe("/base/path/relative");
    });

    it("should return absolute path unchanged regardless of base", () => {
      const absolutePath = "/absolute/path";
      const basePath = "/base";
      const result = service.toAbsoluteFrom(absolutePath, basePath);
      expect(result).toBe(absolutePath);
    });
  });

  describe("isAbsolute", () => {
    it("should return true for absolute paths", () => {
      expect(service.isAbsolute("/absolute/path")).toBe(true);
    });

    it("should return false for relative paths", () => {
      expect(service.isAbsolute("./relative")).toBe(false);
      expect(service.isAbsolute("relative")).toBe(false);
    });
  });

  describe("sanitizeBranchName", () => {
    it("should replace slashes with dashes", () => {
      expect(service.sanitizeBranchName("feature/test")).toBe("feature-test");
    });

    it("should replace special characters with underscores", () => {
      expect(service.sanitizeBranchName("bug#123")).toBe("bug_123");
      expect(service.sanitizeBranchName("user@domain")).toBe("user_domain");
    });

    it("should handle complex branch names", () => {
      expect(service.sanitizeBranchName("feature/bug#123@hotfix")).toBe("feature-bug_123_hotfix");
    });

    it("should preserve alphanumeric and basic characters", () => {
      expect(service.sanitizeBranchName("feat-123_test")).toBe("feat-123_test");
    });
  });

  describe("getBranchWorktreePath", () => {
    it("should construct worktree path from base and branch", () => {
      const result = service.getBranchWorktreePath("/worktrees", "feature/test");
      expect(result).toBe("/worktrees/feature/test");
    });
  });

  describe("getParentDirectory", () => {
    it("should return parent directory", () => {
      const result = service.getParentDirectory("/path/to/file");
      expect(result).toBe("/path/to");
    });
  });

  describe("joinPaths", () => {
    it("should join multiple paths", () => {
      const result = service.joinPaths("/base", "middle", "end");
      expect(result).toBe("/base/middle/end");
    });
  });

  describe("getRelativePath", () => {
    it("should return relative path from one location to another", () => {
      const result = service.getRelativePath("/base/path", "/base/path/sub/dir");
      expect(result).toBe("sub/dir");
    });
  });

  describe("normalizeWorktreePath", () => {
    it("should extract relative path within base directory", () => {
      const result = service.normalizeWorktreePath("/base/worktrees/feature/test", "/base/worktrees");
      expect(result).toBe("feature/test");
    });

    it("should throw error for path outside base directory", () => {
      expect(() => {
        service.normalizeWorktreePath("/outside/path", "/base/worktrees");
      }).toThrow("is outside base directory");
    });

    it("should throw error for absolute relative path", () => {
      expect(() => {
        service.normalizeWorktreePath("/different/base", "/base/worktrees");
      }).toThrow("is outside base directory");
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
  });

  describe("extractBranchFromWorktreePath", () => {
    it("should extract branch name from worktree path", () => {
      const result = service.extractBranchFromWorktreePath("/worktrees/feature/test", "/worktrees");
      expect(result).toBe("feature/test");
    });

    it("should handle flat branch names", () => {
      const result = service.extractBranchFromWorktreePath("/worktrees/main", "/worktrees");
      expect(result).toBe("main");
    });
  });
});
