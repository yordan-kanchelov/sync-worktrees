import { beforeEach, describe, expect, it } from "vitest";

import { PathResolutionService } from "../path-resolution.service";

describe("PathResolutionService", () => {
  let service: PathResolutionService;

  beforeEach(() => {
    service = new PathResolutionService();
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
