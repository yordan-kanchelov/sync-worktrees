import { describe, expect, it } from "vitest";

import { deriveLabel, deriveSafeToRemove } from "../worktree-summary";

import type { WorktreeStatusResult } from "../../services/worktree-status.service";

function makeStatus(overrides: Partial<WorktreeStatusResult> = {}): WorktreeStatusResult {
  return {
    isClean: true,
    hasUnpushedCommits: false,
    hasStashedChanges: false,
    hasOperationInProgress: false,
    hasModifiedSubmodules: false,
    upstreamGone: false,
    canRemove: true,
    reasons: [],
    ...overrides,
  };
}

describe("deriveLabel", () => {
  it("returns 'current' when worktree is current", () => {
    expect(deriveLabel(makeStatus(), true)).toBe("current");
  });

  it("returns 'dirty' when uncommitted changes", () => {
    expect(deriveLabel(makeStatus({ isClean: false, reasons: ["uncommitted changes"] }), false)).toBe("dirty");
  });

  it("returns 'dirty' when unpushed commits", () => {
    expect(deriveLabel(makeStatus({ hasUnpushedCommits: true, reasons: ["unpushed commits"] }), false)).toBe("dirty");
  });

  it("returns 'stale' when upstream gone but tree clean", () => {
    expect(deriveLabel(makeStatus({ upstreamGone: true }), false)).toBe("stale");
  });

  it("returns 'clean' when all good", () => {
    expect(deriveLabel(makeStatus(), false)).toBe("clean");
  });
});

describe("deriveSafeToRemove", () => {
  it("safe + reason when clean and upstream present", () => {
    const result = deriveSafeToRemove(makeStatus());
    expect(result.safe).toBe(true);
    expect(result.reason).toContain("clean");
  });

  it("unsafe when upstream gone (still has remote, but deleted)", () => {
    const result = deriveSafeToRemove(makeStatus({ upstreamGone: true }));
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("deleted upstream");
  });

  it("unsafe with joined reasons when canRemove=false", () => {
    const result = deriveSafeToRemove(
      makeStatus({
        canRemove: false,
        isClean: false,
        hasUnpushedCommits: true,
        reasons: ["uncommitted changes", "unpushed commits"],
      }),
    );
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("uncommitted changes");
    expect(result.reason).toContain("unpushed commits");
  });

  it("unsafe with fallback when canRemove=false but no reasons", () => {
    const result = deriveSafeToRemove(makeStatus({ canRemove: false }));
    expect(result.safe).toBe(false);
    expect(result.reason).toBe("not safe to remove");
  });
});
