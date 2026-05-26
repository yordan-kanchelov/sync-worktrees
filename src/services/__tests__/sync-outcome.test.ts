import { describe, expect, it } from "vitest";

import { SyncOutcomeAccumulator, cloneSkipToOutcomeAction } from "../sync-outcome";

describe("SyncOutcomeAccumulator", () => {
  it("aggregates action counts and returns immutable snapshots", () => {
    const accumulator = new SyncOutcomeAccumulator({ mode: "worktree", repoName: "demo" });

    accumulator.recordCreated("feature", "/repo/worktrees/feature");
    accumulator.recordUpdated("main", "/repo/worktrees/main", "fast_forward");
    accumulator.recordSkipped("worktree", "dirty_worktree", {
      branch: "wip",
      path: "/repo/worktrees/wip",
    });
    accumulator.recordPreservedDiverged("old", "/repo/worktrees/old", "/repo/worktrees/.diverged/old");
    accumulator.recordFailed("worktree", "boom", { branch: "broken" });
    accumulator.recordNoop("worktree", "already_up_to_date", {
      branch: "main",
      path: "/repo/worktrees/main",
    });

    const outcome = accumulator.toOutcome(123);

    expect(outcome).toMatchObject({
      repoName: "demo",
      mode: "worktree",
      started: true,
      durationMs: 123,
      counts: {
        created: 1,
        removed: 0,
        updated: 1,
        skipped: 1,
        preserved: 1,
        failed: 1,
        noop: 1,
      },
    });
    expect(outcome.actions).toHaveLength(6);

    outcome.actions.pop();
    expect(accumulator.toOutcome().actions).toHaveLength(6);
  });

  it("restores a checkpoint before recording a later retry attempt", () => {
    const accumulator = new SyncOutcomeAccumulator({ mode: "worktree", repoName: "demo" });

    accumulator.recordCreated("main", "/repo/worktrees/main");
    const checkpoint = accumulator.snapshot();

    accumulator.recordFailed("worktree", "temporary network error", {
      reason: "update_failed",
      branch: "feature",
    });
    accumulator.restore(checkpoint);
    accumulator.recordUpdated("feature", "/repo/worktrees/feature", "fast_forward");

    expect(accumulator.toOutcome().counts).toMatchObject({
      created: 1,
      updated: 1,
      failed: 0,
    });
    expect(accumulator.toOutcome().actions).toEqual([
      { kind: "created", branch: "main", path: "/repo/worktrees/main" },
      { kind: "updated", branch: "feature", path: "/repo/worktrees/feature", reason: "fast_forward" },
    ]);
  });

  it("converts clone skip reasons to common skipped actions", () => {
    expect(
      cloneSkipToOutcomeAction(
        { kind: "branch_mismatch", phase: "sync", currentBranch: "feature", expectedBranch: "main" },
        { path: "/repo/clone" },
      ),
    ).toEqual({
      kind: "skipped",
      scope: "repo",
      reason: "clone_branch_mismatch",
      branch: "main",
      path: "/repo/clone",
      message: "clone is on 'feature', expected 'main'",
    });
  });
});
