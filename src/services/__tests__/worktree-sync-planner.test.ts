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

    it("gives a new branch its plain directory name", () => {
      const actions = planCreateActions(makeInventory(), { pathResolution });

      expect(actions).toEqual([{ kind: "create", branch: "feature/signup", path: `${worktreeDir}/feature-signup` }]);
    });

    it("hashes every branch that flattens to the same name as another (slash vs dash)", () => {
      const actions = planCreateActions(
        makeInventory({ remoteBranches: ["main", "feature/x", "feature-x"], existingWorktrees: [] }),
        { pathResolution },
      );

      expect(actions).toEqual([
        {
          kind: "create",
          branch: "feature/x",
          path: `${worktreeDir}/${pathResolution.sanitizeBranchName("feature/x")}`,
        },
        {
          kind: "create",
          branch: "feature-x",
          path: `${worktreeDir}/${pathResolution.sanitizeBranchName("feature-x")}`,
        },
      ]);
    });

    it("hashes branches whose names differ only in case", () => {
      const actions = planCreateActions(
        makeInventory({ remoteBranches: ["main", "Feature-X", "feature-x"], existingWorktrees: [] }),
        { pathResolution },
      );

      expect(actions.map((action) => action.path)).toEqual([
        `${worktreeDir}/${pathResolution.sanitizeBranchName("Feature-X")}`,
        `${worktreeDir}/${pathResolution.sanitizeBranchName("feature-x")}`,
      ]);
    });

    it("never gives a branch the default branch's directory name, in any case", () => {
      const actions = planCreateActions(
        makeInventory({ remoteBranches: ["main", "Main", "release"], defaultBranch: "main", existingWorktrees: [] }),
        { pathResolution },
      );

      expect(actions).toEqual([
        { kind: "create", branch: "Main", path: `${worktreeDir}/${pathResolution.sanitizeBranchName("Main")}` },
        { kind: "create", branch: "release", path: `${worktreeDir}/release` },
      ]);
    });

    it("keeps a nested default branch's directory components reserved", () => {
      const actions = planCreateActions(
        makeInventory({
          remoteBranches: ["release/2024", "2024", "Release"],
          defaultBranch: "release/2024",
          existingWorktrees: [],
        }),
        { pathResolution },
      );

      // `<worktreeDir>/release/2024` is the anchor, and `2024` is its metadata key.
      expect(actions.map((action) => action.path)).toEqual([
        `${worktreeDir}/${pathResolution.sanitizeBranchName("2024")}`,
        `${worktreeDir}/${pathResolution.sanitizeBranchName("Release")}`,
      ]);
    });

    it("hashes the name when another branch's registered worktree already holds it", () => {
      const actions = planCreateActions(
        makeInventory({
          remoteBranches: ["main", "feature/new"],
          existingWorktrees: [{ path: `${worktreeDir}/feature-new`, branch: "legacy/path-owner" }],
        }),
        { pathResolution },
      );

      expect(actions).toEqual([
        {
          kind: "create",
          branch: "feature/new",
          path: `${worktreeDir}/${pathResolution.sanitizeBranchName("feature/new")}`,
        },
      ]);
    });

    it("leaves existing hashed worktrees where they are while new branches get plain names", () => {
      const hashedLogin = `${worktreeDir}/${pathResolution.sanitizeBranchName("feature/login")}`;
      const plan = createWorktreeSyncPlan(
        makeInventory({ existingWorktrees: [{ path: hashedLogin, branch: "feature/login" }] }),
        { pathResolution },
      );

      expect(plan.create).toEqual([
        { kind: "create", branch: "feature/signup", path: `${worktreeDir}/feature-signup` },
      ]);
      expect(plan.update).toEqual([{ kind: "update-candidate", branch: "feature/login", path: hashedLogin }]);
      expect(plan.prune).toEqual([]);
    });

    it("skips create actions when a resolved path collides with another branch", () => {
      // A naming context that does not know about the registration (the
      // runner's always does): the planner's own path check is the backstop.
      const collidingPath = wtPath("feature/new");
      const actions = planCreateActions(
        makeInventory({
          remoteBranches: ["main", "feature/new"],
          existingWorktrees: [{ path: collidingPath, branch: "legacy/path-owner" }],
        }),
        { pathResolution, naming: pathResolution.createNamingContext({ branches: [] }) },
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

    // `git worktree remove` refuses a locked worktree, so planning it as a
    // prune candidate would spend a status probe, a size scan and two renames
    // on it every tick only to be refused.
    it("plans a locked worktree as a deliberate skip instead of a prune check", () => {
      const actions = planPruneActions(
        makeInventory({
          remoteBranches: ["main"],
          existingWorktrees: [
            { path: wtPath("feature/locked"), branch: "feature/locked", locked: true, lockReason: "demo box" },
            { path: wtPath("feature/stale"), branch: "feature/stale" },
          ],
        }),
      );

      expect(actions).toEqual([
        {
          kind: "skip-prune",
          branch: "feature/locked",
          path: wtPath("feature/locked"),
          reason: "locked",
          lockReason: "demo box",
        },
        { kind: "check-prune", branch: "feature/stale", path: wtPath("feature/stale") },
      ]);
    });

    it("plans a lock without a reason as a skip that carries no reason", () => {
      const actions = planPruneActions(
        makeInventory({
          remoteBranches: ["main"],
          existingWorktrees: [{ path: wtPath("feature/locked"), branch: "feature/locked", locked: true }],
        }),
      );

      expect(actions).toEqual([
        { kind: "skip-prune", branch: "feature/locked", path: wtPath("feature/locked"), reason: "locked" },
      ]);
    });

    // The prune plan is only ever as good as the inventory it reads: names the
    // remote listing loses (a branch ending in "/HEAD", one carrying "|", one
    // literally named "origin") used to arrive here as unknown branches and be
    // trashed. Whatever their shape, a branch that is on the remote is never a
    // prune candidate.
    it("never plans a worktree whose branch is still on the remote, whatever its name", () => {
      const branches = ["feature/HEAD", "feature|wip", "origin", "release/2.0"];

      const actions = planPruneActions(
        makeInventory({
          remoteBranches: ["main", ...branches],
          existingWorktrees: branches.map((branch) => ({ path: wtPath(branch), branch })),
        }),
      );

      expect(actions).toEqual([]);
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
