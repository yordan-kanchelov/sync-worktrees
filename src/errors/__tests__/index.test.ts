import { describe, expect, it } from "vitest";

import { ERROR_MESSAGES } from "../../constants";
import {
  ConfigValidationError,
  FastForwardError,
  GitOperationError,
  SyncWorktreesError,
  UpstreamSetupError,
  WorktreeError,
  WorktreeMetadataError,
  WorktreeNotCleanError,
  isFastForwardError,
  isLfsError,
  isNoUpstreamError,
} from "../index";

describe("Error Classes", () => {
  it.each([
    {
      create: () => new SyncWorktreesError("base failure", "BASE_FAILED"),
      code: "BASE_FAILED",
      message: "base failure",
    },
    {
      create: () => new GitOperationError("fetch", "network timeout"),
      code: "GIT_OPERATION_FAILED",
      message: "Git operation 'fetch' failed: network timeout",
    },
    {
      create: () => new FastForwardError("feature/test"),
      code: "GIT_FAST_FORWARD_FAILED",
      message: "Cannot fast-forward branch 'feature/test'",
    },
    {
      create: () => new WorktreeNotCleanError("/repo/worktree", ["uncommitted changes", "stashed changes"]),
      code: "WORKTREE_NOT_CLEAN",
      message: "Worktree at '/repo/worktree' is not clean: uncommitted changes, stashed changes",
    },
    {
      create: () => new ConfigValidationError("repoUrl", "is required"),
      code: "CONFIG_VALIDATION_FAILED",
      message: "Invalid configuration for 'repoUrl': is required",
    },
    {
      create: () => new WorktreeMetadataError("feature/test", new Error("disk full")),
      code: "WORKTREE_METADATA_FAILED",
      message: "Metadata creation failed for 'feature/test': disk full",
    },
    {
      create: () => new UpstreamSetupError("feature/test", new Error("no such ref"), true),
      code: "WORKTREE_UPSTREAM_SETUP_FAILED",
      message: "Failed to set upstream for 'feature/test': no such ref",
    },
    {
      create: () => new UpstreamSetupError("feature/test", "no such ref", false),
      code: "WORKTREE_UPSTREAM_SETUP_FAILED",
      message: "Failed to set upstream for 'feature/test': no such ref (rollback failed; partial worktree may remain)",
    },
  ])("should preserve the public $code contract", ({ create, code, message }) => {
    const error = create();

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(error.constructor.name);
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
  });
});

describe("addWorktree failure errors", () => {
  it("are WorktreeErrors that keep the branch name and the underlying cause", () => {
    const cause = new Error("disk full");
    const metadata = new WorktreeMetadataError("feature/test", cause);
    const upstream = new UpstreamSetupError("feature/test", cause, false);

    for (const error of [metadata, upstream]) {
      expect(error).toBeInstanceOf(WorktreeError);
      expect(error.branchName).toBe("feature/test");
      expect(error.cause).toBe(cause);
    }
    expect(upstream.rollbackSucceeded).toBe(false);
  });

  it("drops a non-Error cause from the chain but keeps its text in the message", () => {
    const error = new WorktreeMetadataError("feature/test", "plain string");

    expect(error.cause).toBeUndefined();
    expect(error.message).toBe("Metadata creation failed for 'feature/test': plain string");
  });
});

describe("Error Detection Functions", () => {
  describe("isLfsError", () => {
    it("should detect LFS errors from Error objects", () => {
      const lfsError = new Error("smudge filter lfs failed");
      expect(isLfsError(lfsError)).toBe(true);
    });

    it("should detect LFS errors from string messages", () => {
      expect(isLfsError("smudge filter lfs failed")).toBe(true);
      expect(isLfsError("Object does not exist on the server")).toBe(true);
      expect(isLfsError("external filter 'git-lfs filter-process' failed")).toBe(true);
    });

    it("should return false for non-LFS errors", () => {
      expect(isLfsError(new Error("network timeout"))).toBe(false);
      expect(isLfsError("regular git error")).toBe(false);
    });

    it("should use the stricter shared LFS classifier", () => {
      expect(isLfsError("git-lfs pull failed")).toBe(false);
      expect(isLfsError("LFS: error downloading")).toBe(false);
    });
  });

  describe("isFastForwardError", () => {
    it("should detect fast-forward errors from Error objects", () => {
      const ffError = new Error("Not possible to fast-forward");
      expect(isFastForwardError(ffError)).toBe(true);
    });

    it("should detect fast-forward errors from string messages", () => {
      expect(isFastForwardError("fatal: Not possible to fast-forward")).toBe(true);
    });

    it("should return false for non-fast-forward errors", () => {
      expect(isFastForwardError(new Error("merge conflict"))).toBe(false);
      expect(isFastForwardError("regular error")).toBe(false);
    });

    it("should detect all fast-forward error patterns", () => {
      ERROR_MESSAGES.FAST_FORWARD_FAILED.forEach((pattern) => {
        expect(isFastForwardError(pattern)).toBe(true);
      });
    });
  });

  describe("isNoUpstreamError", () => {
    it("should detect no upstream errors from Error objects", () => {
      const noUpstream = new Error("fatal: no upstream configured for branch");
      expect(isNoUpstreamError(noUpstream)).toBe(true);
    });

    it("should detect no upstream errors from string messages", () => {
      expect(isNoUpstreamError("fatal: no upstream configured")).toBe(true);
      expect(isNoUpstreamError("unknown revision or path not in working tree")).toBe(true);
    });

    it("should return false for non-upstream errors", () => {
      expect(isNoUpstreamError(new Error("merge conflict"))).toBe(false);
      expect(isNoUpstreamError("regular error")).toBe(false);
    });

    it("should detect all no upstream error patterns", () => {
      ERROR_MESSAGES.NO_UPSTREAM.forEach((pattern) => {
        expect(isNoUpstreamError(pattern)).toBe(true);
      });
    });
  });
});
