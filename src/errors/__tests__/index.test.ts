import { describe, expect, it } from "vitest";

import {
  ConfigValidationError,
  FastForwardError,
  GitOperationError,
  SyncWorktreesError,
  UpstreamSetupError,
  WorktreeError,
  WorktreeMetadataError,
  WorktreeNotCleanError,
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
