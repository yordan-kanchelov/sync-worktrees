import * as fs from "fs/promises";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempDirectories, createMockLogger, createTempDirectory } from "../../__tests__/test-utils";
import { TrashService } from "../trash.service";
import { WorktreeSyncService } from "../worktree-sync.service";

import type * as DiskSpace from "../../utils/disk-space";
import type { Config } from "../../types";
import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { RemovalAuditService } from "../removal-audit.service";

const probe = vi.hoisted(() => ({
  events: [] as string[],
  couldStartOperationDuringScan: [] as boolean[],
  lockHeld: false,
  inScan: false,
  onScan: null as null | (() => Promise<void>),
}));

vi.mock("../../utils/disk-space", async (importOriginal) => {
  const actual = await importOriginal<typeof DiskSpace>();
  return {
    ...actual,
    calculateDirectorySize: vi.fn(async (dirPath: string) => {
      probe.events.push("size");
      if (probe.onScan) await probe.onScan();
      return actual.calculateDirectorySize(dirPath);
    }),
  };
});

vi.mock("../repo-operation-lock", () => ({
  RepoOperationLock: vi.fn(function () {
    return {
      updateLogger: vi.fn(),
      acquire: vi.fn(async () => {
        if (probe.lockHeld) return { acquired: false, reason: "locked" };
        const label = probe.inScan ? "probe:lock" : "lock";
        probe.lockHeld = true;
        probe.events.push(`${label}:acquire`);
        return {
          acquired: true,
          release: async (): Promise<void> => {
            probe.lockHeld = false;
            probe.events.push(`${label}:release`);
          },
        };
      }),
    };
  }),
}));

vi.mock("../git-maintenance.service", () => ({
  GitMaintenanceService: vi.fn(function () {
    return {
      updateLogger: vi.fn(),
      runIfDueUnlocked: vi.fn<any>().mockResolvedValue(undefined),
      runNowUnlocked: vi.fn<any>().mockResolvedValue(true),
    };
  }),
}));

const gitStub = vi.hoisted(() => ({
  instance: null as any,
}));

vi.mock("../git.service", () => ({
  GitService: vi.fn(function () {
    return gitStub.instance;
  }),
}));

function makeGitStub(bareRepoPath: string) {
  return {
    initialize: vi.fn<any>().mockResolvedValue(undefined),
    isInitialized: vi.fn().mockReturnValue(true),
    updateLogger: vi.fn(),
    setStaleDirectoryTrasher: vi.fn(),
    ensureAnchorWorktree: vi.fn<any>().mockResolvedValue(false),
    getMainWorktreePath: vi.fn(() => path.join(bareRepoPath, "..", "main")),
    getBareRepoPath: vi.fn(() => bareRepoPath),
    fetchAll: vi.fn<any>().mockResolvedValue(undefined),
    getRemoteBranches: vi.fn<any>().mockResolvedValue([]),
    getRemoteBranchesWithActivity: vi.fn<any>().mockResolvedValue([]),
    getRemoteBranchTips: vi.fn<any>().mockResolvedValue(new Map()),
    recordRemoteTip: vi.fn<any>().mockResolvedValue(undefined),
    getDefaultBranch: vi.fn(() => "main"),
    refreshDefaultBranch: vi.fn<any>().mockResolvedValue({
      previous: "main",
      defaultBranch: "main",
      mainWorktreePath: path.join(bareRepoPath, "..", "main"),
      created: false,
    }),
    getWorktrees: vi.fn<any>().mockResolvedValue([]),
    getWorktreeLock: vi.fn<any>().mockResolvedValue({ locked: false }),
    getWorktreeMetadata: vi.fn<any>().mockResolvedValue(null),
    getCurrentCommit: vi.fn<any>().mockResolvedValue("abc123"),
    removeWorktree: vi.fn<any>().mockResolvedValue(undefined),
    updateRef: vi.fn<any>().mockResolvedValue(undefined),
    deleteRef: vi.fn<any>().mockResolvedValue(undefined),
    listRefs: vi.fn<any>().mockResolvedValue([]),
    deleteLocalBranch: vi.fn<any>().mockResolvedValue(undefined),
    deleteLocalBranchIfAt: vi.fn<any>().mockResolvedValue(undefined),
  };
}

describe("trash sizing never runs under the repository lock", () => {
  let worktreeDir: string;
  let bareRepoPath: string;
  let config: Config;
  let service: WorktreeSyncService;

  beforeEach(async () => {
    worktreeDir = await createTempDirectory();
    bareRepoPath = path.join(worktreeDir, ".bare");
    await fs.mkdir(bareRepoPath, { recursive: true });
    await fs.writeFile(path.join(bareRepoPath, "HEAD"), "ref: refs/heads/main\n");

    probe.events = [];
    probe.couldStartOperationDuringScan = [];
    probe.lockHeld = false;
    probe.inScan = false;
    probe.onScan = null;

    gitStub.instance = makeGitStub(bareRepoPath);
    config = {
      repoUrl: "https://github.com/test/repo.git",
      worktreeDir,
      cronSchedule: "0 * * * *",
      runOnce: true,
      logger: createMockLogger(),
    };
    service = new WorktreeSyncService(config);

    probe.onScan = async () => {
      probe.inScan = true;
      try {
        const result = await service.runExclusiveRepoOperation(async () => "probe");
        probe.couldStartOperationDuringScan.push(result.started);
      } finally {
        probe.inScan = false;
      }
    };
  });

  afterEach(async () => {
    await cleanupTempDirectories();
  });

  async function seedUnsizedEntry(name: string): Promise<string> {
    const trash = new TrashService(
      config,
      gitStub.instance as unknown as GitService,
      createMockLogger() as Logger,
      { record: vi.fn<any>().mockResolvedValue(undefined) } as unknown as RemovalAuditService,
    );
    const source = path.join(worktreeDir, name);
    await fs.mkdir(path.join(source, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(source, "node_modules", "big.js"), "x".repeat(8192));
    const entry = await trash.trashDirectory({ dirPath: source, branch: name, reason: "prune" });
    expect(entry.manifest.sizeBytes).toBeNull();
    return entry.manifest.id;
  }

  it("sizes a tick's trash only after sync has released the lock", async () => {
    await seedUnsizedEntry("feature-x");
    probe.events.length = 0;

    const result = await service.sync();
    expect(result.started).toBe(true);

    expect(probe.events).toEqual(["lock:acquire", "lock:release", "size", "probe:lock:acquire", "probe:lock:release"]);
    expect(probe.couldStartOperationDuringScan).toEqual([true]);

    const { entries } = await service.listTrashEntries();
    expect(entries[0].manifest.sizeBytes).toBeGreaterThan(0);
  });

  it("still sizes what a failing tick trashed — the throw leaves exactly the entries this measures", async () => {
    await seedUnsizedEntry("feature-doomed");
    config.retry = { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, jitterMs: 0 };
    gitStub.instance.getRemoteBranches.mockRejectedValue(new Error("fetch exploded"));
    probe.events.length = 0;

    await expect(service.sync()).rejects.toThrow("fetch exploded");

    expect(probe.events).toEqual(["lock:acquire", "lock:release", "size", "probe:lock:acquire", "probe:lock:release"]);
    expect(probe.couldStartOperationDuringScan).toEqual([true]);

    const { entries } = await service.listTrashEntries();
    expect(entries[0].manifest.sizeBytes).toBeGreaterThan(0);
  });

  it("sizes nothing when the lock was never taken — a refused sync trashed nothing to measure", async () => {
    await seedUnsizedEntry("feature-blocked");
    probe.lockHeld = true;
    probe.events.length = 0;

    const result = await service.sync();

    expect(result).toMatchObject({ started: false, reason: "locked" });
    expect(probe.events).not.toContain("size");
  });

  it("sizes nothing that is already sized, so a quiet tick execs no du at all", async () => {
    await seedUnsizedEntry("feature-y");
    await service.sync();
    probe.events.length = 0;

    await service.sync();

    expect(probe.events).not.toContain("size");
  });

  it("measures for the force-clean confirmation, outside the repo mutex", async () => {
    await seedUnsizedEntry("feature-z");
    probe.events.length = 0;

    const preview = await service.getForceCleanPreview();

    expect(probe.events).toContain("size");
    expect(probe.couldStartOperationDuringScan).toEqual([true]);
    expect(preview.trashEntries).toBe(1);
    expect(preview.unknownTrashSizes).toBe(0);
    expect(preview.trashBytes).toBeGreaterThan(0);
  });

  it("does not measure the survivors it recounts inside force clean", async () => {
    const purged = await seedUnsizedEntry("feature-purged");
    const preview = await service.getForceCleanPreview();
    expect(preview.trashEntryIds).toEqual([purged]);

    await seedUnsizedEntry("feature-survivor");
    probe.events.length = 0;

    const result = await service.forceClean({ trashEntryIds: preview.trashEntryIds, keepRefNames: [] });

    expect(result.skippedNewEntries).toBe(1);
    expect(result.trashEntries).toBe(1);
    expect(probe.events).not.toContain("size");
    expect(result.unknownTrashSizes).toBe(1);
  });
});
