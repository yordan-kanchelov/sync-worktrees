import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { PathResolutionService } from "../path-resolution.service";
import { ProgressEmitter } from "../progress-emitter";
import { SyncDryRunPlanBuilder } from "../sync-plan";
import { WorktreeModeSyncRunner } from "../worktree-mode-sync-runner";

import type { GitService } from "../git.service";
import type { RemovalAuditService } from "../removal-audit.service";
import type { TrashService } from "../trash.service";
import type { Config } from "../../types";

// planSyncAttempt is `sync --dry-run`'s worktree-mode half: every decision the
// sync would take, through the same assessments, and nothing that writes. The
// GitService here is a proxy that answers only the read-only calls the plan is
// allowed to make and throws on anything else, so a mutation reintroduced into
// a shared assessment fails this file rather than a user's repository.
describe("WorktreeModeSyncRunner.planSyncAttempt", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let worktreeDir: string;
  let calls: string[];

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-runner-plan-")));
    worktreeDir = path.join(tempDir, "worktrees");
    calls = [];
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const wt = (branch: string): string => pathResolution.getBranchWorktreePath(worktreeDir, branch);

  function readOnlyGitService(overrides: Record<string, (...args: unknown[]) => unknown>): GitService {
    // The naming probe every plan runs: both only read.
    const reads: Record<string, (...args: unknown[]) => unknown> = {
      getBareRepoPath: () => path.join(tempDir, ".bare"),
      readWorktreeMetadataOwner: async () => null,
      ...overrides,
    };
    return new Proxy({} as GitService, {
      get(_target, property: string) {
        if (property === "then") return undefined;
        const read = reads[property];
        if (!read) {
          return () => {
            throw new Error(`planSyncAttempt called GitService.${property}, which it must not`);
          };
        }
        return (...args: unknown[]) => {
          calls.push(property);
          return read(...args);
        };
      },
    });
  }

  function makeRunner(gitService: GitService, config: Partial<Config> = {}): WorktreeModeSyncRunner {
    const fullConfig: Config = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      logger: createMockLogger(),
      ...config,
    };
    const trashService = {
      isEnabled: () => true,
      updateLogger: () => {},
      listEntries: vi.fn().mockResolvedValue({ entries: [], invalid: [] }),
    } as unknown as TrashService;
    const removalAudit = {
      record: vi.fn().mockRejectedValue(new Error("a plan must not write the audit log")),
    } as unknown as RemovalAuditService;
    return new WorktreeModeSyncRunner(fullConfig, gitService, createMockLogger(), new ProgressEmitter(), {
      trashService,
      removalAudit,
    });
  }

  it("reports create, fast-forward, prune, diverged replace and noop without a single write", async () => {
    for (const branch of ["main", "behind", "diverged", "stale", "dirty"]) {
      await fs.mkdir(wt(branch), { recursive: true });
    }

    const gitService = readOnlyGitService({
      getMainWorktreePath: () => wt("main"),
      getDefaultBranch: () => "main",
      getRemoteBranches: async () => ["main", "behind", "diverged", "dirty", "fresh"],
      getWorktrees: async () => [
        { path: wt("main"), branch: "main", head: "m1" },
        { path: wt("behind"), branch: "behind", head: "b1" },
        { path: wt("diverged"), branch: "diverged", head: "d1" },
        { path: wt("dirty"), branch: "dirty", head: "x1" },
        { path: wt("stale"), branch: "stale", head: "s1" },
      ],
      getFullWorktreeStatus: async () => ({
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: true,
        fullyPushedUpstreamDeleted: true,
        canRemove: true,
        reasons: [],
        divergence: null,
      }),
      getRemoteBranchTips: async () =>
        new Map([
          ["main", "m1"],
          ["behind", "b2"],
          ["diverged", "d2"],
          ["dirty", "x2"],
        ]),
      hasOperationInProgress: async () => false,
      checkWorktreeStatus: async (worktreePath: unknown) => worktreePath !== wt("dirty"),
      getAheadBehindCounts: async (worktreePath: unknown) =>
        worktreePath === wt("diverged") ? { ahead: 1, behind: 1 } : { ahead: 0, behind: 2 },
      hasStashedChanges: async () => false,
      getCurrentCommit: async () => "d1",
      compareTreeContent: async () => false,
      getWorktreeMetadata: async () => ({ lastSyncCommit: "d0" }),
    });

    const plan = new SyncDryRunPlanBuilder({ mode: "worktree", repoName: "app" });
    await makeRunner(gitService).planSyncAttempt(plan);
    const { steps, counts } = plan.build();

    expect(steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "create", branch: "fresh", path: wt("fresh"), reason: "new_branch" }),
        expect.objectContaining({ kind: "update", branch: "behind", reason: "fast_forward" }),
        expect.objectContaining({ kind: "skip", branch: "dirty", reason: "dirty_worktree" }),
        expect.objectContaining({ kind: "replace", branch: "diverged", preservedIn: "trash" }),
        expect.objectContaining({
          kind: "remove",
          branch: "stale",
          reason: "deleted_on_remote",
          basis: "fully_pushed_remote_deleted",
          disposal: "trash",
          message: "fully pushed, remote branch deleted; moved to trash",
        }),
        expect.objectContaining({ kind: "noop", branch: "main", reason: "already_up_to_date" }),
      ]),
    );
    expect(counts).toMatchObject({ create: 1, update: 1, skip: 1, replace: 1, remove: 1, noop: 1 });
    // Nothing on disk moved either.
    await expect(fs.access(wt("fresh"))).rejects.toThrow();
    await expect(fs.access(wt("stale"))).resolves.toBeUndefined();
    expect(calls).not.toContain("recordRemoteTip");
  });

  it("plans the default-branch worktree when it is missing and notes a default origin no longer has", async () => {
    const gitService = readOnlyGitService({
      getMainWorktreePath: () => wt("main"),
      getDefaultBranch: () => "main",
      getRemoteBranches: async () => ["trunk"],
      getWorktrees: async () => [],
      getRemoteBranchTips: async () => new Map(),
    });

    const plan = new SyncDryRunPlanBuilder({ mode: "worktree" });
    await makeRunner(gitService).planSyncAttempt(plan);
    const built = plan.build();

    expect(built.steps).toEqual([
      { kind: "create", branch: "main", path: wt("main"), reason: "default_branch" },
      { kind: "create", branch: "trunk", path: wt("trunk"), reason: "new_branch" },
    ]);
    expect(built.notes).toEqual([expect.stringContaining("Default branch 'main' does not exist on origin")]);
  });

  it("keeps a fully pushed worktree when trash is off, as the sync would", async () => {
    await fs.mkdir(wt("stale"), { recursive: true });
    const gitService = readOnlyGitService({
      getMainWorktreePath: () => worktreeDir,
      getDefaultBranch: () => "main",
      getRemoteBranches: async () => ["main"],
      getWorktrees: async () => [{ path: wt("stale"), branch: "stale" }],
      getFullWorktreeStatus: async () => ({ canRemove: true, fullyPushedUpstreamDeleted: true, reasons: [] }),
      getRemoteBranchTips: async () => new Map(),
    });
    const runner = new WorktreeModeSyncRunner(
      { repoUrl: "u", worktreeDir, cronSchedule: "* * * * *", runOnce: true, updateExistingWorktrees: false },
      gitService,
      createMockLogger(),
      new ProgressEmitter(),
      {
        trashService: { isEnabled: () => false, updateLogger: () => {} } as unknown as TrashService,
        removalAudit: {} as unknown as RemovalAuditService,
      },
    );

    const plan = new SyncDryRunPlanBuilder({ mode: "worktree" });
    await runner.planSyncAttempt(plan);

    expect(plan.build().steps).toContainEqual(
      expect.objectContaining({ kind: "skip", branch: "stale", reason: "fully_pushed_trash_disabled" }),
    );
  });
});
