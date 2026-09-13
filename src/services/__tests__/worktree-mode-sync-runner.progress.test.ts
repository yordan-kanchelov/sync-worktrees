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
import type { ProgressEvent } from "../progress-emitter";
import type { RemovalAuditService } from "../removal-audit.service";
import type { TrashService } from "../trash.service";
import type { Config } from "../../types";

// Progress used to be five messages for a whole attempt, so a create phase
// working through hundreds of branches showed one static line for as long as it
// ran. Each phase now counts the items it finished; these cover the counts
// themselves, and that concurrent phases still report a sequence that only
// moves forward.
describe("WorktreeModeSyncRunner phase item progress", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let worktreeDir: string;
  let mainPath: string;
  let logger: Logger;
  let events: ProgressEvent[];
  let progressEmitter: ProgressEmitter;
  let gitService: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-runner-progress-")));
    worktreeDir = path.join(tempDir, "worktrees");
    mainPath = pathResolution.getBranchWorktreePath(worktreeDir, "main");
    await fs.mkdir(mainPath, { recursive: true });
    logger = createMockLogger();
    events = [];
    progressEmitter = new ProgressEmitter();
    progressEmitter.onProgress((event) => events.push(event));

    gitService = {
      ensureAnchorWorktree: vi.fn().mockResolvedValue(false),
      fetchAll: vi.fn().mockResolvedValue(undefined),
      getRemoteBranches: vi.fn().mockResolvedValue(["main"]),
      getDefaultBranch: vi.fn().mockReturnValue("main"),
      getWorktrees: vi.fn().mockResolvedValue([{ path: mainPath, branch: "main" }]),
      addWorktree: vi.fn().mockResolvedValue({ status: "created", head: "abc1234" }),
      getRemoteCommit: vi.fn().mockResolvedValue("abc1234"),
      getRemoteBranchTips: vi.fn().mockResolvedValue(new Map()),
      recordRemoteTip: vi.fn().mockResolvedValue(undefined),
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
      updateExistingWorktrees: false,
      trash: { enabled: false },
      ...overrides,
    };

    return new WorktreeModeSyncRunner(config, gitService as unknown as GitService, logger, progressEmitter, {
      trashService: { isEnabled: () => false, updateLogger: () => {} } as unknown as TrashService,
      removalAudit: { record: vi.fn().mockResolvedValue(undefined) } as unknown as RemovalAuditService,
    });
  }

  async function run(runner: WorktreeModeSyncRunner = makeRunner()): Promise<void> {
    await runner.runSyncAttempt(
      new PhaseTimer(),
      { lfsSkipEnabled: false },
      new SyncOutcomeAccumulator({ mode: "worktree" }),
    );
  }

  function itemEvents(phase: string, label: string): ProgressEvent[] {
    return events.filter((event) => event.phase === phase && event.message.startsWith(`${label}:`));
  }

  function counts(phase: string, label: string): Array<{ processed?: number; total?: number }> {
    return itemEvents(phase, label).map(({ processed, total }) => ({ processed, total }));
  }

  // Existing worktrees for every branch listed, so the planner sees updates and
  // sparse candidates rather than creates.
  async function withExistingWorktrees(branches: Array<{ branch: string; head?: string }>): Promise<void> {
    const worktrees = [{ path: mainPath, branch: "main", head: "main-head" }];
    for (const { branch, head } of branches) {
      const worktreePath = pathResolution.getBranchWorktreePath(worktreeDir, branch);
      await fs.mkdir(worktreePath, { recursive: true });
      worktrees.push({ path: worktreePath, branch, ...(head !== undefined && { head }) } as (typeof worktrees)[number]);
    }
    gitService.getWorktrees.mockResolvedValue(worktrees);
  }

  it("reports one create event per branch with a running count", async () => {
    gitService.getRemoteBranches.mockResolvedValue(["main", "feature-1", "feature-2", "feature-3"]);

    await run();

    expect(counts("create", "Creating worktrees")).toEqual([
      { processed: 1, total: 3 },
      { processed: 2, total: 3 },
      { processed: 3, total: 3 },
    ]);
    expect(itemEvents("create", "Creating worktrees").map((event) => event.message)).toEqual([
      "Creating worktrees: 'feature-1' (1/3)",
      "Creating worktrees: 'feature-2' (2/3)",
      "Creating worktrees: 'feature-3' (3/3)",
    ]);
    // The phase still announces itself before any branch is done.
    expect(events[1]).toMatchObject({ phase: "create", message: "Creating worktrees for new branches" });
  });

  it("counts a branch that failed or was skipped, so the count still reaches the total", async () => {
    gitService.getRemoteBranches.mockResolvedValue(["main", "feature-1", "feature-2", "feature-3"]);
    gitService.addWorktree.mockImplementation(async (branch: string) => {
      if (branch === "feature-1") throw new Error("boom");
      if (branch === "feature-2") return { status: "already_registered", detached: true };
      return { status: "created", head: "abc1234" };
    });

    await run();

    expect(counts("create", "Creating worktrees")).toEqual([
      { processed: 1, total: 3 },
      { processed: 2, total: 3 },
      { processed: 3, total: 3 },
    ]);
  });

  // Creations run concurrently, so a count taken where a branch is dispatched
  // would arrive out of order. The count follows completions instead.
  it("counts concurrent creations in the order they finish, never backwards", async () => {
    gitService.getRemoteBranches.mockResolvedValue(["main", "feature-1", "feature-2", "feature-3"]);
    const gates = new Map<string, () => void>();
    gitService.addWorktree.mockImplementation(async (branch: string) => {
      await new Promise<void>((resolve) => gates.set(branch, resolve));
      return { status: "created", head: "abc1234" };
    });

    const attempt = run(makeRunner({ parallelism: { maxWorktreeCreation: 3 } }));
    await waitFor(() => gates.size === 3);

    // Finished in an order the dispatch cannot predict.
    for (const branch of ["feature-3", "feature-1", "feature-2"]) {
      gates.get(branch)!();
      await settle();
    }
    await attempt;

    expect(itemEvents("create", "Creating worktrees").map((event) => event.message)).toEqual([
      "Creating worktrees: 'feature-3' (1/3)",
      "Creating worktrees: 'feature-1' (2/3)",
      "Creating worktrees: 'feature-2' (3/3)",
    ]);
    expect(counts("create", "Creating worktrees")).toEqual([
      { processed: 1, total: 3 },
      { processed: 2, total: 3 },
      { processed: 3, total: 3 },
    ]);
  });

  it("counts the prune checks and the removals as two stages of the phase", async () => {
    await withExistingWorktrees([{ branch: "gone-1" }, { branch: "gone-2" }]);
    gitService.getFullWorktreeStatus = vi.fn().mockResolvedValue({ canRemove: true, reasons: [] });
    gitService.removeWorktree = vi.fn().mockResolvedValue(undefined);

    await run();

    expect(counts("prune", "Checking worktrees to prune")).toEqual([
      { processed: 1, total: 2 },
      { processed: 2, total: 2 },
    ]);
    expect(counts("prune", "Pruning stale worktrees")).toEqual([
      { processed: 1, total: 2 },
      { processed: 2, total: 2 },
    ]);
  });

  // The update phase settles a worktree whose HEAD already matches origin's tip
  // without spawning anything for it. Those still count: they are part of what
  // the user is waiting on, and leaving them out would give the count a total it
  // could never reach.
  it("counts every update candidate, including the ones settled without a git call", async () => {
    gitService.getRemoteBranches.mockResolvedValue(["main", "settled", "behind-1", "behind-2"]);
    await withExistingWorktrees([
      { branch: "settled", head: "settled-tip" },
      { branch: "behind-1", head: "old-1" },
      { branch: "behind-2", head: "old-2" },
    ]);
    gitService.getRemoteBranchTips.mockResolvedValue(
      new Map([
        ["main", "main-head"],
        ["settled", "settled-tip"],
        ["behind-1", "new-1"],
        ["behind-2", "new-2"],
      ]),
    );
    gitService.hasOperationInProgress = vi.fn().mockResolvedValue(false);
    gitService.checkWorktreeStatus = vi.fn().mockResolvedValue(true);
    gitService.getAheadBehindCounts = vi.fn().mockResolvedValue({ ahead: 0, behind: 1 });
    gitService.updateWorktree = vi.fn().mockResolvedValue({ updated: true });

    await run(makeRunner({ updateExistingWorktrees: true }));

    // Four candidates: main and 'settled' never reach a git probe.
    expect(counts("update", "Checking worktrees for updates")).toEqual([
      { processed: 1, total: 4 },
      { processed: 2, total: 4 },
      { processed: 3, total: 4 },
      { processed: 4, total: 4 },
    ]);
    expect(gitService.getAheadBehindCounts).toHaveBeenCalledTimes(2);
    // Only the two worktrees actually behind reach the mutation stage.
    expect(counts("update", "Updating worktrees")).toEqual([
      { processed: 1, total: 2 },
      { processed: 2, total: 2 },
    ]);
  });

  it("counts the sparse-checkout reconciliations", async () => {
    gitService.getRemoteBranches.mockResolvedValue(["main", "feature-1"]);
    await withExistingWorktrees([{ branch: "feature-1" }]);
    gitService.getSparseCheckoutService = vi.fn().mockReturnValue({
      buildPatterns: vi.fn().mockReturnValue(["src/"]),
      readCurrent: vi.fn().mockResolvedValue(null),
      patternsEqual: vi.fn().mockReturnValue(false),
      isNarrowing: vi.fn().mockReturnValue(false),
      applyToWorktree: vi.fn().mockResolvedValue(undefined),
    });
    gitService.checkoutHead = vi.fn().mockResolvedValue(undefined);

    await run(makeRunner({ sparseCheckout: { include: ["src/"] } }));

    expect(events).toContainEqual({ phase: "sparse", message: "Reconciling sparse-checkout patterns" });
    expect(counts("sparse", "Reconciling sparse-checkout")).toEqual([
      { processed: 1, total: 2 },
      { processed: 2, total: 2 },
    ]);
  });
});

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) {
    await settle();
  }
  if (!condition()) throw new Error("condition was never met");
}
