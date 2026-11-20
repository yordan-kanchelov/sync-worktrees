import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockLogger } from "../../__tests__/test-utils";
import { PathResolutionService } from "../path-resolution.service";
import { ProgressEmitter } from "../progress-emitter";
import { SyncOutcomeAccumulator } from "../sync-outcome";
import { PATH_CONTAINMENT_CONCURRENCY, WorktreeModeSyncRunner } from "../worktree-mode-sync-runner";
import { PhaseTimer } from "../../utils/timing";

import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { RemovalAuditService } from "../removal-audit.service";
import type { TrashService } from "../trash.service";
import type { Config } from "../../types";
import type * as FsModule from "fs";
import type * as FsPromisesModule from "fs/promises";

const spies = vi.hoisted(() => ({
  existsSync: vi.fn(),
  realpathSync: vi.fn(),
  realpath: vi.fn(),
  inFlight: 0,
  peakInFlight: 0,
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof FsModule>("fs");
  const realpathSync = ((...args: Parameters<typeof actual.realpathSync>) => {
    spies.realpathSync(...args);
    return actual.realpathSync(...args);
  }) as typeof actual.realpathSync;
  realpathSync.native = actual.realpathSync.native;
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof actual.existsSync>) => {
      spies.existsSync(...args);
      return actual.existsSync(...args);
    },
    realpathSync,
  };
});

vi.mock("fs/promises", async () => {
  const actual = await vi.importActual<typeof FsPromisesModule>("fs/promises");
  return {
    ...actual,
    realpath: (...args: Parameters<typeof actual.realpath>) => {
      spies.realpath(...args);
      spies.inFlight += 1;
      spies.peakInFlight = Math.max(spies.peakInFlight, spies.inFlight);
      return actual.realpath(...args).finally(() => {
        spies.inFlight -= 1;
      });
    },
  };
});

const WORKTREE_COUNT = 400;

describe("WorktreeModeSyncRunner worktreeDir partition", () => {
  const pathResolution = new PathResolutionService();
  let tempDir: string;
  let worktreeDir: string;
  let registered: { path: string; branch: string }[];
  let logger: Logger;
  let gitService: Record<string, ReturnType<typeof vi.fn>>;
  let onFoundLog: (() => void) | undefined;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-worktrees-partition-")));
    worktreeDir = path.join(tempDir, "worktrees");
    await fs.mkdir(worktreeDir, { recursive: true });

    registered = [];
    for (let index = 0; index < WORKTREE_COUNT; index++) {
      const branch = `feature/branch-${index}`;
      const worktreePath = pathResolution.getBranchWorktreePath(worktreeDir, branch);
      await fs.mkdir(worktreePath, { recursive: true });
      registered.push({ path: worktreePath, branch });
    }

    onFoundLog = undefined;
    logger = createMockLogger();
    const info = logger.info as unknown as ReturnType<typeof vi.fn>;
    info.mockImplementation((message: string) => {
      if (/^Found \d+ managed Git worktrees\.$/.test(message)) onFoundLog?.();
    });

    gitService = {
      ensureAnchorWorktree: vi.fn().mockResolvedValue(false),
      getMainWorktreePath: vi.fn().mockReturnValue(path.join(worktreeDir, "main")),
      fetchAll: vi.fn().mockResolvedValue(undefined),
      getRemoteBranches: vi.fn().mockResolvedValue(["main"]),
      getDefaultBranch: vi.fn().mockReturnValue("main"),
      getWorktrees: vi.fn().mockImplementation(async () => registered),
      getRemoteBranchTips: vi.fn().mockResolvedValue(new Map()),
      getFullWorktreeStatus: vi.fn().mockResolvedValue({ canRemove: false, reasons: ["has uncommitted changes"] }),
      setLfsSkipEnabled: vi.fn(),
      getBareRepoPath: vi.fn().mockReturnValue(path.join(tempDir, "bare")),
      readWorktreeMetadataOwner: vi.fn().mockResolvedValue(null),
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

  async function run(): Promise<void> {
    const runner = makeRunner();
    spies.existsSync.mockClear();
    spies.realpathSync.mockClear();
    spies.realpath.mockClear();
    await runner.runSyncAttempt(
      new PhaseTimer(),
      { lfsSkipEnabled: false },
      new SyncOutcomeAccumulator({ mode: "worktree" }),
    );
  }

  it("classifies every registered worktree without a synchronous filesystem call", async () => {
    await run();

    expect(logger.info).toHaveBeenCalledWith(`Found ${WORKTREE_COUNT} managed Git worktrees.`);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("external worktree outside worktreeDir"));
    expect(spies.existsSync).not.toHaveBeenCalled();
    expect(spies.realpathSync).not.toHaveBeenCalled();
  });

  it("resolves worktreeDir once for the whole partition, not once per worktree", async () => {
    await run();

    const resolvedTargets = spies.realpath.mock.calls.map(([target]) => target as string);
    expect(resolvedTargets.filter((target) => target === worktreeDir)).toEqual([worktreeDir]);
    expect(resolvedTargets[0]).toBe(worktreeDir);
    expect(resolvedTargets).toHaveLength(WORKTREE_COUNT + 1);
  });

  it("still classifies a worktree that reaches outside worktreeDir through a symlink as external", async () => {
    const outside = path.join(tempDir, "elsewhere");
    await fs.mkdir(outside, { recursive: true });
    const escape = path.join(worktreeDir, "escape");
    try {
      await fs.symlink(outside, escape, "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN" || code === "ENOSYS") return;
      throw error;
    }
    registered.push({ path: path.join(escape, "worktree"), branch: "feature/escaped" });

    await run();

    expect(logger.info).toHaveBeenCalledWith(`Found ${WORKTREE_COUNT} managed Git worktrees.`);
    expect(logger.warn).toHaveBeenCalledWith(
      `  - Skipping external worktree outside worktreeDir: ${path.join(escape, "worktree")}`,
    );
  });

  it("lets the event loop run while partitioning", async () => {
    let ticks = 0;
    let probing = false;
    const tick = (): void => {
      if (!probing) return;
      ticks++;
      setImmediate(tick);
    };
    gitService.getWorktrees.mockImplementation(async () => {
      probing = true;
      spies.peakInFlight = 0;
      setImmediate(tick);
      return registered;
    });
    onFoundLog = () => {
      probing = false;
    };

    await run();

    expect(ticks).toBeGreaterThan(0);
    expect(spies.peakInFlight).toBeGreaterThan(0);
    expect(spies.peakInFlight).toBeLessThanOrEqual(PATH_CONTAINMENT_CONCURRENCY);
  });
});
