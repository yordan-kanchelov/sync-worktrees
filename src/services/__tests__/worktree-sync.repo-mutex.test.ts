import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TrashError } from "../../errors";
import { TrashReaperService } from "../trash-reaper.service";
import { TrashService } from "../trash.service";
import { WorktreeSyncService } from "../worktree-sync.service";

import type { Config } from "../../types";
import type { Logger } from "../logger.service";
import type { TrashEntry } from "../trash.service";
import type { Mock } from "vitest";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  gitInitialize: vi.fn(),
  gitIsInitialized: vi.fn(() => true),
}));

vi.mock("../git.service", () => ({
  GitService: vi.fn(function () {
    return {
      initialize: mocks.gitInitialize,
      isInitialized: mocks.gitIsInitialized,
      updateLogger: vi.fn(),
      setStaleDirectoryTrasher: vi.fn(),
    };
  }),
}));

vi.mock("../repo-operation-lock", () => ({
  RepoOperationLock: vi.fn(function () {
    return { acquire: mocks.acquire, updateLogger: vi.fn() };
  }),
}));

function makeConfig(): Config {
  return {
    repoUrl: "https://github.com/test/repo.git",
    worktreeDir: "/tmp/worktrees",
    cronSchedule: "0 * * * *",
    runOnce: true,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      table: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("WorktreeSyncService repo mutex / queued operations", () => {
  let service: WorktreeSyncService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.release.mockResolvedValue(undefined);
    mocks.acquire.mockResolvedValue({ acquired: true, release: mocks.release });
    mocks.gitInitialize.mockResolvedValue(undefined);
    mocks.gitIsInitialized.mockReturnValue(true);
    service = new WorktreeSyncService(makeConfig());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a fail-fast op while another operation is in flight", async () => {
    const started = deferred<void>();
    const hold = deferred<void>();

    const first = service.runExclusiveRepoOperation(async () => {
      started.resolve();
      await hold.promise;
    });
    await started.promise;

    const second = await service.runExclusiveRepoOperation(async () => "blocked");
    expect(second).toEqual({ started: false, reason: "in_progress" });

    hold.resolve();
    await first;
  });

  it("runs the real init once when two callers race initialize() on a fresh repo", async () => {
    mocks.gitIsInitialized.mockReturnValue(false);
    const entered = deferred<void>();
    const hold = deferred<void>();
    mocks.gitInitialize.mockImplementation(async () => {
      entered.resolve();
      await hold.promise;
      mocks.gitIsInitialized.mockReturnValue(true);
    });

    expect(service.isInitialized()).toBe(false);
    const first = service.initialize();
    await entered.promise;
    expect(service.isInitialized()).toBe(false);

    await service.initialize();
    expect(mocks.gitInitialize).toHaveBeenCalledTimes(1);
    const logger = service.config.logger as unknown as { warn: Mock };
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Initialize skipped: operation in progress"));

    hold.resolve();
    await first;
    expect(mocks.gitInitialize).toHaveBeenCalledTimes(1);
  });

  it("queues a wait:true op behind the in-flight op and runs it after release", async () => {
    const order: string[] = [];
    const started = deferred<void>();
    const hold = deferred<void>();

    const first = service.runExclusiveRepoOperation(async () => {
      order.push("first-start");
      started.resolve();
      await hold.promise;
      order.push("first-end");
    });
    await started.promise;

    const second = service.runQueuedRepoOperation(async () => {
      order.push("second-run");
      return "done";
    });

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);

    hold.resolve();
    const result = await second;
    await first;

    expect(order).toEqual(["first-start", "first-end", "second-run"]);
    expect(result).toEqual({ started: true, value: "done" });
    expect(mocks.acquire).toHaveBeenCalledTimes(2);
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });

  it("reports isSyncInProgress for active and queued ops, idle otherwise", async () => {
    expect(service.isSyncInProgress()).toBe(false);

    const started = deferred<void>();
    const hold = deferred<void>();
    const first = service.runExclusiveRepoOperation(async () => {
      started.resolve();
      await hold.promise;
    });
    await started.promise;
    expect(service.isSyncInProgress()).toBe(true);

    const second = service.runQueuedRepoOperation(async () => undefined);
    expect(service.isSyncInProgress()).toBe(true);

    hold.resolve();
    await Promise.all([first, second]);
    expect(service.isSyncInProgress()).toBe(false);
  });

  it("returns locked when another process holds the file lock", async () => {
    mocks.acquire.mockResolvedValueOnce({ acquired: false, reason: "locked" });
    const result = await service.runQueuedRepoOperation(async () => "value");
    expect(result).toEqual({ started: false, reason: "locked" });
  });

  it("returns lock_unavailable with its cause, logged as an error, when the lock cannot be prepared", async () => {
    mocks.acquire.mockResolvedValueOnce({
      acquired: false,
      reason: "lock_unavailable",
      path: "/state/sync-worktrees/locks",
      code: "ENOTDIR",
      error: "ENOTDIR: not a directory, mkdir '/state/sync-worktrees/locks'",
    });
    const result = await service.runQueuedRepoOperation(async () => "value");

    expect(result).toEqual({
      started: false,
      reason: "lock_unavailable",
      path: "/state/sync-worktrees/locks",
      code: "ENOTDIR",
      error: "ENOTDIR: not a directory, mkdir '/state/sync-worktrees/locks'",
    });
    const logger = service.config.logger as unknown as { error: Mock; warn: Mock };
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("/state/sync-worktrees/locks"));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("ENOTDIR"));
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("Another process holds"));
  });

  describe("trash operations and the cross-process lock", () => {
    it("takes the lock fail-fast by default and with a bounded budget under --wait", async () => {
      await expect(service.purgeTrashEntry("missing-entry")).rejects.toThrow("no trash entry with id");
      expect(mocks.acquire).toHaveBeenLastCalledWith({ waitMs: undefined });

      await expect(service.purgeTrashEntry("missing-entry", { lockWaitMs: 90_000 })).rejects.toThrow(
        "no trash entry with id",
      );
      expect(mocks.acquire).toHaveBeenLastCalledWith({ waitMs: 90_000 });

      await expect(service.restoreFromTrash("missing-entry", { lockWaitMs: 90_000 })).rejects.toThrow(
        "no trash entry with id",
      );
      expect(mocks.acquire).toHaveBeenLastCalledWith({ waitMs: 90_000 });
    });

    it("reports a lock another process holds as a purge failure rather than a crash", async () => {
      mocks.acquire.mockResolvedValueOnce({ acquired: false, reason: "locked" });

      await expect(service.purgeTrashEntry("any-entry")).rejects.toThrow(
        "cannot purge trash entry 'any-entry': another process holds the repository lock",
      );
    });

    it("reports a keep-ref drop the lock refused as a trash error", async () => {
      mocks.acquire.mockResolvedValueOnce({ acquired: false, reason: "locked" });
      await expect(service.deleteKeepRef("preserved-entry")).rejects.toBeInstanceOf(TrashError);

      mocks.acquire.mockResolvedValueOnce({ acquired: false, reason: "locked" });
      await expect(service.deleteKeepRefs(["preserved-entry"])).rejects.toBeInstanceOf(TrashError);
    });

    it("purges one named entry through the reap path that mints keep refs", async () => {
      const entry = { manifest: { id: "entry-1" } } as unknown as TrashEntry;
      vi.spyOn(TrashService.prototype, "listEntries").mockResolvedValue({ entries: [entry], invalid: [] });
      const purgeEntry = vi.spyOn(TrashReaperService.prototype, "purgeEntryUnlocked").mockResolvedValue({
        deleted: 1,
        orphanedRefsDeleted: 0,
        skippedNotSelected: 0,
        keepRefsMinted: ["refs/sync-worktrees/keep/entry-1"],
        errors: [],
      });
      const purgeAll = vi.spyOn(TrashReaperService.prototype, "purgeAllUnlocked");

      await expect(service.purgeTrashEntry("entry-1")).resolves.toEqual({
        deleted: true,
        keepRefsMinted: ["refs/sync-worktrees/keep/entry-1"],
        errors: [],
      });

      expect(purgeEntry).toHaveBeenCalledWith("entry-1");
      expect(purgeAll).not.toHaveBeenCalled();
    });

    it("reports a purge that deleted nothing as a failure, not a success", async () => {
      const entry = { manifest: { id: "entry-2" } } as unknown as TrashEntry;
      vi.spyOn(TrashService.prototype, "listEntries").mockResolvedValue({ entries: [entry], invalid: [] });
      vi.spyOn(TrashReaperService.prototype, "purgeEntryUnlocked").mockResolvedValue({
        deleted: 0,
        orphanedRefsDeleted: 0,
        skippedNotSelected: 0,
        keepRefsMinted: [],
        errors: ["entry-2: payload is locked"],
      });

      await expect(service.purgeTrashEntry("entry-2")).resolves.toEqual({
        deleted: false,
        keepRefsMinted: [],
        errors: ["entry-2: payload is locked"],
      });
    });
  });

  it("releases the file lock even when the operation throws", async () => {
    await expect(
      service.runQueuedRepoOperation(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(service.isSyncInProgress()).toBe(false);
    const next = await service.runQueuedRepoOperation(async () => "ok");
    expect(next).toEqual({ started: true, value: "ok" });
  });
});
