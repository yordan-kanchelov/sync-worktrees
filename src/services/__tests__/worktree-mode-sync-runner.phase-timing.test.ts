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
import type { ProgressEvent } from "../progress-emitter";
import type { RemovalAuditService } from "../removal-audit.service";
import type { TrashService } from "../trash.service";
import type { Config } from "../../types";

// The `--debug` timing table: every step of a worktree-mode attempt that costs
// time belongs to a phase row, so the rows add up to the attempt. The clock is
// moved by hand inside the mocked git calls, so each row's duration is exactly
// what the step spent.
describe("WorktreeModeSyncRunner phase timing", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let worktreeDir: string;
  let mainPath: string;
  let now: number;
  let events: ProgressEvent[];
  let gitService: Record<string, ReturnType<typeof vi.fn>>;

  const spend = (ms: number): void => {
    now += ms;
  };

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-runner-timing-")));
    worktreeDir = path.join(tempDir, "worktrees");
    mainPath = pathResolution.getBranchWorktreePath(worktreeDir, "main");
    const featurePath = pathResolution.getBranchWorktreePath(worktreeDir, "feature-1");
    await fs.mkdir(mainPath, { recursive: true });
    await fs.mkdir(featurePath, { recursive: true });
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    events = [];

    gitService = {
      ensureAnchorWorktree: vi.fn().mockResolvedValue(false),
      getMainWorktreePath: vi.fn().mockReturnValue(mainPath),
      fetchAll: vi.fn(async () => spend(1000)),
      getRemoteBranches: vi.fn().mockResolvedValue(["main", "feature-1"]),
      getDefaultBranch: vi.fn().mockReturnValue("main"),
      getWorktrees: vi.fn().mockResolvedValue([
        { path: mainPath, branch: "main", head: "main-head" },
        { path: featurePath, branch: "feature-1", head: "feature-head" },
      ]),
      getRemoteCommit: vi.fn().mockResolvedValue("abc1234"),
      getRemoteBranchTips: vi.fn().mockResolvedValue(new Map()),
      recordRemoteTip: vi.fn().mockResolvedValue(undefined),
      setLfsSkipEnabled: vi.fn(),
      getBareRepoPath: vi.fn().mockReturnValue(path.join(tempDir, "bare")),
      readWorktreeMetadataOwner: vi.fn().mockResolvedValue(null),
      checkoutHead: vi.fn().mockResolvedValue(undefined),
      getSparseCheckoutService: vi.fn().mockReturnValue({
        buildPatterns: vi.fn().mockReturnValue(["src/"]),
        readCurrent: vi.fn().mockResolvedValue(null),
        readCurrentMode: vi.fn().mockResolvedValue(null),
        resolveMode: vi.fn().mockReturnValue("cone"),
        patternsEqual: vi.fn().mockReturnValue(false),
        isNarrowing: vi.fn().mockReturnValue(false),
        applyToWorktree: vi.fn(async () => spend(4000)),
      }),
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("times the sparse reconcile as its own phase and reports no empty cleanup phase", async () => {
    const logger = createMockLogger();
    const config: Config = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      logger,
      updateExistingWorktrees: false,
      trash: { enabled: false },
      sparseCheckout: { include: ["src/"] },
    };
    const progressEmitter = new ProgressEmitter();
    progressEmitter.onProgress((event) => events.push(event));
    const runner = new WorktreeModeSyncRunner(config, gitService as unknown as GitService, logger, progressEmitter, {
      trashService: { isEnabled: () => false, updateLogger: () => {} } as unknown as TrashService,
      removalAudit: { record: vi.fn().mockResolvedValue(undefined) } as unknown as RemovalAuditService,
    });
    const phaseTimer = new PhaseTimer();
    const start = now;

    await runner.runSyncAttempt(
      phaseTimer,
      { lfsSkipEnabled: false },
      new SyncOutcomeAccumulator({ mode: "worktree" }),
    );

    const total = now - start;
    const results = phaseTimer.getResults();
    const sparse = results.find((result) => result.name.includes("Sparse"));
    expect(sparse).toMatchObject({ duration: 8000, count: 2 });
    expect(results.map((result) => result.name)).not.toContain("Phase 5: Cleanup");
    expect(events.some((event) => event.phase === "cleanup")).toBe(false);
    expect(results.reduce((sum, result) => sum + result.duration, 0)).toBe(total);
  });
});
