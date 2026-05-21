import { describe, expect, it } from "vitest";

import { formatCloneSkipReason } from "../clone-skip-format";

import type { CloneSkipReason } from "../../services/clone-sync.service";

describe("formatCloneSkipReason", () => {
  it("formats branch_mismatch at init phase with 'since process start' suffix", () => {
    const reason: CloneSkipReason = {
      kind: "branch_mismatch",
      phase: "init",
      currentBranch: "sidebranch",
      expectedBranch: "master",
    };
    expect(formatCloneSkipReason(reason)).toBe("clone is on 'sidebranch', expected 'master' (since process start)");
  });

  it("formats branch_mismatch at sync phase without suffix", () => {
    const reason: CloneSkipReason = {
      kind: "branch_mismatch",
      phase: "sync",
      currentBranch: "sidebranch",
      expectedBranch: "master",
    };
    expect(formatCloneSkipReason(reason)).toBe("clone is on 'sidebranch', expected 'master'");
  });

  it("formats head_unreadable with the underlying error", () => {
    const reason: CloneSkipReason = { kind: "head_unreadable", phase: "init", error: "not a git repo" };
    expect(formatCloneSkipReason(reason)).toBe("could not read HEAD: not a git repo");
  });

  it("formats dirty_tree", () => {
    expect(formatCloneSkipReason({ kind: "dirty_tree" })).toBe("working tree has local changes");
  });

  it("formats diverged with branch context", () => {
    expect(formatCloneSkipReason({ kind: "diverged", branch: "main" })).toBe("diverged from origin/main");
  });

  it("formats ahead_unpushed with branch context", () => {
    expect(formatCloneSkipReason({ kind: "ahead_unpushed", branch: "main" })).toBe(
      "unpushed commits ahead of origin/main",
    );
  });

  it("formats missing_remote_ref source fetch_error", () => {
    expect(formatCloneSkipReason({ kind: "missing_remote_ref", branch: "main", source: "fetch_error" })).toBe(
      "origin/main missing on remote (fetch error)",
    );
  });

  it("formats missing_remote_ref source post_fetch_verify", () => {
    expect(
      formatCloneSkipReason({
        kind: "missing_remote_ref",
        branch: "main",
        source: "post_fetch_verify",
      }),
    ).toBe("origin/main pruned after fetch");
  });

  it("formats indeterminate_shallow with branch and deepen target", () => {
    expect(
      formatCloneSkipReason({
        kind: "indeterminate_shallow",
        branch: "main",
        deepenedTo: 1000,
      }),
    ).toBe(
      "unable to classify origin/main after deepening shallow history to 1000 commits — remove or raise 'depth' to unshallow",
    );
  });

  it("formats indeterminate_shallow when no deepening was attempted", () => {
    expect(
      formatCloneSkipReason({
        kind: "indeterminate_shallow",
        branch: "main",
        deepenedTo: null,
      }),
    ).toBe(
      "unable to classify origin/main (no deepening attempted — configured depth already at or above all deepen targets) — remove 'depth' to unshallow",
    );
  });
});
