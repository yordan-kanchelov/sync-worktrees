import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { PathResolutionService } from "../path-resolution.service";
import { ProgressEmitter } from "../progress-emitter";
import { SyncOutcomeAccumulator } from "../sync-outcome";
import { WorktreeModeSyncRunner } from "../worktree-mode-sync-runner";
import { PhaseTimer } from "../../utils/timing";

import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { RemovalAuditService } from "../removal-audit.service";
import type { SyncRetryContext } from "../sync-retry-policy";
import type { TrashService } from "../trash.service";
import type { Config, SyncOutcome } from "../../types";

const LFS_FAILURE = "fatal: assets/big.bin: smudge filter lfs failed";

// `git worktree add` is where Git LFS actually fails — its checkout runs the
// smudge filter, while the fetch into the bare repo never does. These cover the
// per-branch fallback that turns such a failure into one retry with
// GIT_LFS_SKIP_SMUDGE=1 instead of a create_failed repeated on every tick.
describe("WorktreeModeSyncRunner LFS checkout fallback", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let worktreeDir: string;
  let mainPath: string;
  let logger: Logger;
  let gitService: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-runner-lfs-")));
    worktreeDir = path.join(tempDir, "worktrees");
    mainPath = pathResolution.getBranchWorktreePath(worktreeDir, "main");
    // The default branch's worktree is never a create action; it exists so the
    // planner leaves it alone and every create below is a real new branch.
    await fs.mkdir(mainPath, { recursive: true });
    logger = createMockLogger();

    gitService = {
      ensureAnchorWorktree: vi.fn().mockResolvedValue(false),
      fetchAll: vi.fn().mockResolvedValue(undefined),
      getRemoteBranches: vi.fn().mockResolvedValue(["main", "feature-1"]),
      getDefaultBranch: vi.fn().mockReturnValue("main"),
      getWorktrees: vi.fn().mockResolvedValue([{ path: mainPath, branch: "main" }]),
      addWorktree: vi.fn().mockResolvedValue("abc1234"),
      getRemoteCommit: vi.fn().mockResolvedValue("abc1234"),
      getRemoteBranchTips: vi.fn().mockResolvedValue(new Map()),
      setLfsSkipEnabled: vi.fn(),
    };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeRunner(overrides: Partial<Config> = {}): WorktreeModeSyncRunner {
    const config: Config = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      logger,
      // Phase 4 has nothing to do unless a test says otherwise.
      updateExistingWorktrees: false,
      trash: { enabled: false },
      ...overrides,
    };

    return new WorktreeModeSyncRunner(config, gitService as unknown as GitService, logger, new ProgressEmitter(), {
      trashService: { isEnabled: () => false, updateLogger: () => {} } as unknown as TrashService,
      removalAudit: { record: vi.fn().mockResolvedValue(undefined) } as unknown as RemovalAuditService,
    });
  }

  async function run(
    runner: WorktreeModeSyncRunner,
    syncContext: SyncRetryContext = { lfsSkipEnabled: false },
  ): Promise<SyncOutcome> {
    const outcome = new SyncOutcomeAccumulator({ mode: "worktree" });
    await runner.runSyncAttempt(new PhaseTimer(), syncContext, outcome);
    return outcome.toOutcome();
  }

  it("retries a branch whose checkout failed with an LFS error, with LFS downloads disabled", async () => {
    gitService.addWorktree.mockRejectedValueOnce(new Error(LFS_FAILURE)).mockResolvedValue("abc1234");

    const syncContext: SyncRetryContext = { lfsSkipEnabled: false };
    const outcome = await run(makeRunner(), syncContext);

    expect(gitService.setLfsSkipEnabled).toHaveBeenCalledWith(true);
    expect(gitService.addWorktree).toHaveBeenCalledTimes(2);
    const featurePath = pathResolution.getBranchWorktreePath(worktreeDir, "feature-1");
    expect(gitService.addWorktree).toHaveBeenNthCalledWith(1, "feature-1", featurePath);
    expect(gitService.addWorktree).toHaveBeenNthCalledWith(2, "feature-1", featurePath);
    expect(outcome.counts).toMatchObject({ created: 1, failed: 0 });
    expect(outcome.actions).toContainEqual(
      expect.objectContaining({ kind: "noop", scope: "repo", reason: "lfs_skip_enabled", branch: "feature-1" }),
    );
    // The flag stays on for the rest of the sync; the sync service's
    // resetLfsSkipIfNeeded turns it back off in its finally block.
    expect(syncContext.lfsSkipEnabled).toBe(true);
    expect(logger.info).toHaveBeenCalledWith("⚠️  Temporarily disabling LFS downloads for this sync...");
  });

  it("records create_failed when the retry with LFS disabled fails the same way", async () => {
    gitService.addWorktree.mockRejectedValue(new Error(LFS_FAILURE));

    const outcome = await run(makeRunner());

    expect(gitService.addWorktree).toHaveBeenCalledTimes(2);
    expect(outcome.counts).toMatchObject({ created: 0, failed: 1 });
    expect(outcome.actions).toContainEqual(
      expect.objectContaining({ kind: "failed", reason: "create_failed", branch: "feature-1", error: LFS_FAILURE }),
    );
  });

  it("does not retry a checkout that already ran with LFS downloads disabled", async () => {
    gitService.addWorktree.mockRejectedValue(new Error(LFS_FAILURE));

    const outcome = await run(makeRunner(), { lfsSkipEnabled: true });

    expect(gitService.addWorktree).toHaveBeenCalledTimes(1);
    expect(gitService.setLfsSkipEnabled).not.toHaveBeenCalled();
    expect(outcome.counts).toMatchObject({ created: 0, failed: 1 });
  });

  it("does not retry when skipLfs is configured, since the checkout already skipped LFS", async () => {
    gitService.addWorktree.mockRejectedValue(new Error(LFS_FAILURE));

    const outcome = await run(makeRunner({ skipLfs: true }));

    expect(gitService.addWorktree).toHaveBeenCalledTimes(1);
    expect(gitService.setLfsSkipEnabled).not.toHaveBeenCalled();
    expect(outcome.counts).toMatchObject({ created: 0, failed: 1 });
  });

  it("does not retry a non-LFS failure", async () => {
    gitService.addWorktree.mockRejectedValue(new Error("fatal: could not create work tree dir: Permission denied"));

    const outcome = await run(makeRunner());

    expect(gitService.addWorktree).toHaveBeenCalledTimes(1);
    expect(gitService.setLfsSkipEnabled).not.toHaveBeenCalled();
    expect(outcome.counts).toMatchObject({ created: 0, failed: 1 });
  });

  // The skip is a GitService-wide switch, so several branches failing at once
  // must flip it once — not once each, with its own warning and action.
  it("enables the skip once when several branches fail with LFS errors concurrently", async () => {
    const created = ["feature-1", "feature-2", "feature-3", "feature-4"];
    gitService.getRemoteBranches.mockResolvedValue(["main", ...created]);
    const failedOnce = new Set<string>();
    gitService.addWorktree.mockImplementation(async (branch: string) => {
      if (!failedOnce.has(branch)) {
        failedOnce.add(branch);
        // Every branch starts its first attempt before any of them fails, so
        // they all observe the skip as disabled and all reach the fallback.
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error(LFS_FAILURE);
      }
      return "abc1234";
    });

    const outcome = await run(makeRunner({ parallelism: { maxWorktreeCreation: created.length } }));

    expect(gitService.setLfsSkipEnabled).toHaveBeenCalledTimes(1);
    expect(gitService.setLfsSkipEnabled).toHaveBeenCalledWith(true);
    expect(gitService.addWorktree).toHaveBeenCalledTimes(created.length * 2);
    expect(outcome.counts).toMatchObject({ created: created.length, failed: 0 });
    expect(outcome.actions.filter((action) => "reason" in action && action.reason === "lfs_skip_enabled")).toHaveLength(
      1,
    );
  });

  it("falls back the same way when the diverged replacement worktree fails its checkout", async () => {
    const branch = "feature/diverged";
    const divergedWorktreePath = pathResolution.getBranchWorktreePath(worktreeDir, branch);
    await fs.mkdir(divergedWorktreePath, { recursive: true });

    gitService.getRemoteBranches.mockResolvedValue(["main", branch]);
    gitService.getWorktrees.mockResolvedValue([
      { path: mainPath, branch: "main" },
      { path: divergedWorktreePath, branch },
    ]);
    gitService.addWorktree.mockRejectedValueOnce(new Error(LFS_FAILURE)).mockResolvedValue("abc1234");

    Object.assign(gitService, {
      hasOperationInProgress: vi.fn().mockResolvedValue(false),
      checkWorktreeStatus: vi.fn().mockResolvedValue(true),
      // Only the diverged branch refuses the fast-forward; main is up to date.
      canFastForward: vi.fn().mockImplementation((worktreePath: string) => worktreePath !== divergedWorktreePath),
      isWorktreeBehind: vi.fn().mockResolvedValue(false),
      isLocalAheadOfRemote: vi.fn().mockResolvedValue(false),
      hasStashedChanges: vi.fn().mockResolvedValue(false),
      getAheadBehindCounts: vi.fn().mockResolvedValue({ ahead: 1, behind: 1 }),
      getCurrentCommit: vi.fn().mockResolvedValue("localtip"),
      compareTreeContent: vi.fn().mockResolvedValue(true),
      resetToUpstream: vi.fn().mockResolvedValue(false),
      removeWorktree: vi.fn().mockResolvedValue(undefined),
      deleteLocalBranch: vi.fn().mockResolvedValue(undefined),
      updateRef: vi.fn().mockResolvedValue(undefined),
      deleteRef: vi.fn().mockResolvedValue(undefined),
      getWorktreeMetadata: vi.fn().mockResolvedValue(null),
    });

    const outcome = await run(makeRunner({ updateExistingWorktrees: true }));

    expect(gitService.setLfsSkipEnabled).toHaveBeenCalledWith(true);
    expect(gitService.addWorktree).toHaveBeenCalledTimes(2);
    expect(outcome.counts.failed).toBe(0);
    expect(outcome.actions).toContainEqual(
      expect.objectContaining({ kind: "noop", reason: "lfs_skip_enabled", branch }),
    );
  });
});
