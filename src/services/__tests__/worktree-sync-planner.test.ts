import { describe, expect, it } from "vitest";

import { PathResolutionService } from "../path-resolution.service";
import {
  createWorktreeSyncPlan,
  planCreateActions,
  planPruneActions,
  planSparseActions,
  planUpdateActions,
} from "../worktree-sync-planner";

import type { WorktreeInventory } from "../worktree-sync-planner";

const pathResolution = new PathResolutionService();
const worktreeDir = "/repo/worktrees";
const wtPath = (branch: string): string => pathResolution.getBranchWorktreePath(worktreeDir, branch);

function makeInventory(overrides: Partial<WorktreeInventory> = {}): WorktreeInventory {
  return {
    remoteBranches: ["main", "feature/login", "feature/signup"],
    defaultBranch: "main",
    existingWorktrees: [{ path: wtPath("feature/login"), branch: "feature/login" }],
    worktreeDir,
    ...overrides,
  };
}

describe("worktree sync planner", () => {
  describe("create planning", () => {
    it("excludes existing branches and the default branch from create actions", () => {
      const actions = planCreateActions(makeInventory(), { pathResolution });

      expect(actions).toEqual([{ kind: "create", branch: "feature/signup", path: wtPath("feature/signup") }]);
    });

    it("resolves slash branch paths through PathResolutionService", () => {
      const actions = planCreateActions(
        makeInventory({
          remoteBranches: ["main", "feat/LCR-8879"],
          existingWorktrees: [],
        }),
        { pathResolution },
      );

      expect(actions).toEqual([{ kind: "create", branch: "feat/LCR-8879", path: wtPath("feat/LCR-8879") }]);
      expect(actions[0]?.path).not.toContain("/feat/LCR-8879");
    });

    it("skips create actions when a resolved path collides with another branch", () => {
      const collidingPath = wtPath("feature/new");
      const actions = planCreateActions(
        makeInventory({
          remoteBranches: ["main", "feature/new"],
          existingWorktrees: [{ path: collidingPath, branch: "legacy/path-owner" }],
        }),
        { pathResolution },
      );

      expect(actions).toEqual([
        {
          kind: "skip-create",
          branch: "feature/new",
          path: collidingPath,
          reason: "path-collision",
          conflictingBranch: "legacy/path-owner",
        },
      ]);
    });
  });

  describe("prune planning", () => {
    it("marks worktrees whose branch is absent from remote branches as prune checks", () => {
      const actions = planPruneActions(
        makeInventory({
          remoteBranches: ["main", "feature/active"],
          existingWorktrees: [
            { path: wtPath("feature/active"), branch: "feature/active" },
            { path: wtPath("feature/stale"), branch: "feature/stale" },
          ],
        }),
      );

      expect(actions).toEqual([{ kind: "check-prune", branch: "feature/stale", path: wtPath("feature/stale") }]);
    });
  });

  describe("update planning", () => {
    it("marks only remote-active worktrees as update candidates", () => {
      const actions = planUpdateActions(
        makeInventory({
          remoteBranches: ["main", "feature/active"],
          existingWorktrees: [
            { path: wtPath("main"), branch: "main" },
            { path: wtPath("feature/active"), branch: "feature/active" },
            { path: wtPath("feature/stale"), branch: "feature/stale" },
          ],
        }),
      );

      expect(actions).toEqual([
        { kind: "update-candidate", branch: "main", path: wtPath("main") },
        { kind: "update-candidate", branch: "feature/active", path: wtPath("feature/active") },
      ]);
    });

    it("omits update candidates when updateExistingWorktrees is disabled", () => {
      const plan = createWorktreeSyncPlan(makeInventory(), {
        pathResolution,
        updateExistingWorktrees: false,
      });

      expect(plan.update).toEqual([]);
    });
  });

  describe("sparse planning", () => {
    it("emits no sparse actions when sparse checkout is not configured", () => {
      expect(planSparseActions(makeInventory())).toEqual([]);
    });

    it("marks existing worktrees as sparse reconciliation candidates when configured", () => {
      const actions = planSparseActions(makeInventory(), { include: ["apps"] });

      expect(actions).toEqual([{ kind: "check-sparse", branch: "feature/login", path: wtPath("feature/login") }]);
    });
  });
});
