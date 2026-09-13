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
import type { TrashService } from "../trash.service";
import type { Config, SyncOutcome } from "../../types";

// `git worktree list` reports a worktree whose HEAD was checked out by hand as
// detached, and the sync inventory drops those entirely — so the branch looks
// new on every tick and the create phase runs against a path that is already a
// registered worktree. addWorktree creates nothing there; what the outcome (and
// the log the user reads) must say is that the worktree was left alone, not
// that it was created again.
describe("WorktreeModeSyncRunner create phase, detached worktree at the target path", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let worktreeDir: string;
  let mainPath: string;
  let featurePath: string;
  let logger: Logger;
  let gitService: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-runner-detached-")));
    worktreeDir = path.join(tempDir, "worktrees");
    mainPath = pathResolution.getBranchWorktreePath(worktreeDir, "main");
    featurePath = pathResolution.getBranchWorktreePath(worktreeDir, "feature-x");
    await fs.mkdir(mainPath, { recursive: true });
    // The directory is still there — only its registration is detached, which
    // is what keeps it out of the inventory below.
    await fs.mkdir(featurePath, { recursive: true });
    logger = createMockLogger();

    gitService = {
      ensureAnchorWorktree: vi.fn().mockResolvedValue(false),
      fetchAll: vi.fn().mockResolvedValue(undefined),
      getRemoteBranches: vi.fn().mockResolvedValue(["main", "feature-x"]),
      getDefaultBranch: vi.fn().mockReturnValue("main"),
      // getWorktrees() filters detached registrations out, so the planner sees
      // feature-x as a branch with no worktree and plans a create for it.
      getWorktrees: vi.fn().mockResolvedValue([{ path: mainPath, branch: "main" }]),
      addWorktree: vi.fn().mockResolvedValue({ status: "already_registered", detached: true }),
      getRemoteCommit: vi.fn().mockResolvedValue("abc1234"),
      getRemoteBranchTips: vi.fn().mockResolvedValue(new Map()),
      setLfsSkipEnabled: vi.fn(),
    };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeRunner(): WorktreeModeSyncRunner {
    const config: Config = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      logger,
      updateExistingWorktrees: false,
      trash: { enabled: false },
    };

    return new WorktreeModeSyncRunner(config, gitService as unknown as GitService, logger, new ProgressEmitter(), {
      trashService: { isEnabled: () => false, updateLogger: () => {} } as unknown as TrashService,
      removalAudit: { record: vi.fn().mockResolvedValue(undefined) } as unknown as RemovalAuditService,
    });
  }

  async function run(runner: WorktreeModeSyncRunner = makeRunner()): Promise<SyncOutcome> {
    const outcome = new SyncOutcomeAccumulator({ mode: "worktree" });
    await runner.runSyncAttempt(new PhaseTimer(), { lfsSkipEnabled: false }, outcome);
    return outcome.toOutcome();
  }

  function loggedLines(): string[] {
    return [logger.info, logger.warn, logger.error].flatMap((method) =>
      (method as unknown as ReturnType<typeof vi.fn>).mock.calls.map((args: unknown[]) => args.join(" ")),
    );
  }

  it("records a skip naming the path instead of counting a creation", async () => {
    const outcome = await run();

    expect(gitService.addWorktree).toHaveBeenCalledWith("feature-x", featurePath);
    expect(outcome.counts).toMatchObject({ created: 0, failed: 0 });
    expect(outcome.actions.filter((action) => action.kind === "created")).toEqual([]);
    expect(outcome.actions).toContainEqual(
      expect.objectContaining({
        kind: "skipped",
        scope: "worktree",
        reason: "detached_worktree",
        branch: "feature-x",
        path: featurePath,
        message: expect.stringContaining(featurePath),
      }),
    );
    expect(loggedLines().some((line) => line.includes("Created worktree"))).toBe(false);
    expect(loggedLines()).toContainEqual(expect.stringContaining("detached HEAD"));
  });

  it("reports the same skip on every later tick, and never a creation", async () => {
    const runner = makeRunner();
    await run(runner);
    const second = await run(runner);

    expect(second.counts).toMatchObject({ created: 0, failed: 0 });
    expect(second.actions).toContainEqual(expect.objectContaining({ reason: "detached_worktree" }));
  });

  // The other way a create finds the path registered: a concurrent creator got
  // there first, on the branch this sync asked for. That worktree is the one
  // the sync wanted, so it still counts as created.
  it("still counts a worktree a concurrent creator registered on the branch", async () => {
    gitService.addWorktree.mockResolvedValue({ status: "already_registered", detached: false });

    const outcome = await run();

    expect(outcome.counts).toMatchObject({ created: 1, failed: 0 });
    expect(outcome.actions).toContainEqual({ kind: "created", branch: "feature-x", path: featurePath });
    // Nothing to compare against origin: this call did not check anything out.
    expect(gitService.getRemoteCommit).not.toHaveBeenCalled();
  });
});
