import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorktreeSyncService } from "../worktree-sync.service";

import type { Config } from "../../types";
import type { Logger } from "../logger.service";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
}));

vi.mock("../git.service", () => ({
  GitService: vi.fn(function () {
    return {
      initialize: vi.fn(),
      isInitialized: vi.fn(() => true),
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
    mocks.acquire.mockResolvedValue(mocks.release);
    service = new WorktreeSyncService(makeConfig());
  });

  it("rejects a fail-fast op while another operation is in flight", async () => {
    const started = deferred<void>();
    const hold = deferred<void>();

    const first = service.runExclusiveRepoOperation(async () => {
      started.resolve();
      await hold.promise;
    });
    await started.promise;

    // A second fail-fast caller (sync/MCP semantics) must not start.
    const second = await service.runExclusiveRepoOperation(async () => "blocked");
    expect(second).toEqual({ started: false, reason: "in_progress" });

    hold.resolve();
    await first;
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

    // The queued op must wait — the first op still holds the single mutex slot.
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);

    hold.resolve();
    const result = await second;
    await first;

    expect(order).toEqual(["first-start", "first-end", "second-run"]);
    expect(result).toEqual({ started: true, value: "done" });
    // Each op acquires and releases the cross-process file lock exactly once.
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

    // A queued op still counts as "in progress" so reload waits for it too.
    const second = service.runQueuedRepoOperation(async () => undefined);
    expect(service.isSyncInProgress()).toBe(true);

    hold.resolve();
    await Promise.all([first, second]);
    expect(service.isSyncInProgress()).toBe(false);
  });

  it("returns locked when another process holds the file lock", async () => {
    mocks.acquire.mockResolvedValueOnce(null);
    const result = await service.runQueuedRepoOperation(async () => "value");
    expect(result).toEqual({ started: false, reason: "locked" });
  });

  it("releases the file lock even when the operation throws", async () => {
    await expect(
      service.runQueuedRepoOperation(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(mocks.release).toHaveBeenCalledTimes(1);
    // Mutex slot freed after the throw — a later op still runs.
    expect(service.isSyncInProgress()).toBe(false);
    const next = await service.runQueuedRepoOperation(async () => "ok");
    expect(next).toEqual({ started: true, value: "ok" });
  });
});
