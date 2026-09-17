import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppEventEmitter } from "../../utils/app-events";
import { DEFAULT_CONFIG } from "../../constants";
import { InteractiveUIService } from "../InteractiveUIService";

import type * as DiskSpaceModule from "../../utils/disk-space";
import type { Config, WorktreeStatusEntry } from "../../types";
import type { WorktreeStatusResult } from "../worktree-status.service";
import type { WorktreeSyncService } from "../worktree-sync.service";

const mocks = vi.hoisted(() => ({
  directorySizes: vi.fn((_dirPath: string) => Promise.resolve(1024)),
}));

vi.mock("ink", () => ({
  render: vi.fn(() => ({ unmount: vi.fn(), waitUntilExit: vi.fn(() => new Promise<void>(() => {})) })),
}));

// Only `calculateDirectorySize` is stood in for: `calculateSyncDiskSpace` and
// `formatBytes` stay real, so the header total this file asserts on is built by
// the code that ships, and the cache under test is the one it really calls.
vi.mock("../../utils/disk-space", async () => {
  const actual = await vi.importActual<typeof DiskSpaceModule>("../../utils/disk-space");
  return { ...actual, calculateDirectorySize: mocks.directorySizes };
});

const cleanStatus: WorktreeStatusResult = {
  isClean: true,
  hasUnpushedCommits: false,
  hasStashedChanges: false,
  hasOperationInProgress: false,
  hasModifiedSubmodules: false,
  upstreamGone: false,
  fullyPushedUpstreamDeleted: false,
  canRemove: true,
  reasons: [],
  divergence: null,
};

interface ProbeRecorder {
  inFlight: number;
  peak: number;
  calls: string[];
}

function makeService(options: {
  worktrees: Array<{ path: string; branch: string }>;
  maxStatusChecks?: number;
  probe: (worktreePath: string, recorder: ProbeRecorder) => Promise<WorktreeStatusResult>;
}): { service: WorktreeSyncService; recorder: ProbeRecorder } {
  const recorder: ProbeRecorder = { inFlight: 0, peak: 0, calls: [] };
  const config = {
    name: "repo-a",
    repoUrl: "https://github.com/test/repo.git",
    worktreeDir: "/tmp/worktrees",
    bareRepoDir: "/tmp/bare",
    ...(options.maxStatusChecks === undefined ? {} : { parallelism: { maxStatusChecks: options.maxStatusChecks } }),
  } as unknown as Config;

  const gitService = {
    getWorktrees: vi.fn(() => Promise.resolve(options.worktrees)),
    getFullWorktreeStatus: vi.fn(async (worktreePath: string) => {
      // The count is taken here, inside the fake, so it records what actually
      // overlapped rather than what the production code was asked to build.
      recorder.calls.push(worktreePath);
      recorder.inFlight += 1;
      if (recorder.inFlight > recorder.peak) recorder.peak = recorder.inFlight;
      try {
        return await options.probe(worktreePath, recorder);
      } finally {
        recorder.inFlight -= 1;
      }
    }),
  };

  const service = {
    config,
    isInitialized: () => true,
    isSyncInProgress: () => false,
    clearRecordedSkips: vi.fn(),
    getRecordedSkips: () => [],
    updateLogger: vi.fn(),
    onProgress: vi.fn(() => () => undefined),
    getGitService: () => gitService,
    getWorktrees: () => Promise.resolve(options.worktrees),
  } as unknown as WorktreeSyncService;

  return { service, recorder };
}

function worktreeList(count: number): Array<{ path: string; branch: string }> {
  return Array.from({ length: count }, (_unused, index) => ({
    path: `/tmp/worktrees/branch-${index}`,
    branch: `branch-${index}`,
  }));
}

describe("getWorktreeStatusForRepo", () => {
  it("never has more probes in flight than maxStatusChecks", async () => {
    const { service, recorder } = makeService({
      worktrees: worktreeList(50),
      maxStatusChecks: 5,
      probe: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return cleanStatus;
      },
    });
    const ui = new InteractiveUIService([service], undefined, undefined, 2, new AppEventEmitter());

    const entries = await ui.getWorktreeStatusForRepo(0);

    expect(recorder.peak).toBe(5);
    expect(recorder.calls).toHaveLength(50);
    expect(entries).toHaveLength(50);
  });

  it("falls back to the shipped MAX_STATUS_CHECKS when the repository configures none", async () => {
    const { service, recorder } = makeService({
      worktrees: worktreeList(60),
      probe: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return cleanStatus;
      },
    });
    const ui = new InteractiveUIService([service], undefined, undefined, 2, new AppEventEmitter());

    await ui.getWorktreeStatusForRepo(0);

    expect(recorder.peak).toBe(DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS);
  });

  it("reports a worktree whose probe rejected instead of dropping it from the list", async () => {
    const { service } = makeService({
      worktrees: worktreeList(3),
      maxStatusChecks: 5,
      probe: (worktreePath) => {
        if (worktreePath.endsWith("branch-1")) {
          return Promise.reject(new Error("fatal: not a git repository"));
        }
        return Promise.resolve(cleanStatus);
      },
    });
    const ui = new InteractiveUIService([service], undefined, undefined, 2, new AppEventEmitter());

    const entries = await ui.getWorktreeStatusForRepo(0);

    // The whole list, in order: the bug this pins was a short list that looked
    // complete, so a prefix check would not have caught it.
    expect(entries).toHaveLength(3);
    expect(entries).toEqual<WorktreeStatusEntry[]>([
      { branch: "branch-0", path: "/tmp/worktrees/branch-0", status: cleanStatus },
      {
        branch: "branch-1",
        path: "/tmp/worktrees/branch-1",
        status: {
          isClean: false,
          hasUnpushedCommits: true,
          hasStashedChanges: true,
          hasOperationInProgress: true,
          hasModifiedSubmodules: true,
          upstreamGone: false,
          fullyPushedUpstreamDeleted: false,
          canRemove: false,
          reasons: ["fatal: not a git repository"],
          divergence: null,
        },
        error: "fatal: not a git repository",
      },
      { branch: "branch-2", path: "/tmp/worktrees/branch-2", status: cleanStatus },
    ]);
  });

  it("never reports a worktree it could not probe as removable", async () => {
    const { service } = makeService({
      worktrees: worktreeList(1),
      probe: () => Promise.reject(new Error("EAGAIN")),
    });
    const ui = new InteractiveUIService([service], undefined, undefined, 2, new AppEventEmitter());

    const [entry] = await ui.getWorktreeStatusForRepo(0);

    expect(entry.status.canRemove).toBe(false);
    expect(entry.error).toBe("EAGAIN");
  });
});

describe("disk usage measurement", () => {
  beforeEach(() => {
    mocks.directorySizes.mockClear();
    mocks.directorySizes.mockImplementation(() => Promise.resolve(1024));
  });

  function makePlainService(name: string): WorktreeSyncService {
    return {
      config: {
        name,
        repoUrl: `https://github.com/test/${name}.git`,
        worktreeDir: `/tmp/${name}/worktrees`,
        bareRepoDir: `/tmp/${name}/bare`,
      } as unknown as Config,
      isInitialized: () => true,
      isSyncInProgress: () => false,
      clearRecordedSkips: vi.fn(),
      getRecordedSkips: () => [],
      updateLogger: vi.fn(),
      onProgress: vi.fn(() => () => undefined),
      getGitService: () => ({ getWorktrees: vi.fn(() => Promise.resolve([])) }),
      getWorktrees: () => Promise.resolve([]),
    } as unknown as WorktreeSyncService;
  }

  it("walks each directory once for the status view, however many times it is opened", async () => {
    const ui = new InteractiveUIService([makePlainService("repo-a")], undefined, undefined, 2, new AppEventEmitter());

    const first = await ui.getRepositoryDiskUsage(0);
    const second = await ui.getRepositoryDiskUsage(0);

    expect(first.sizeBytes).toBe(2048);
    expect(second.sizeBytes).toBe(2048);
    expect(mocks.directorySizes.mock.calls.map((call) => call[0])).toEqual([
      "/tmp/repo-a/bare",
      "/tmp/repo-a/worktrees",
    ]);
  });

  it("shares one walk between a status view opened while the header total is being rebuilt", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.directorySizes.mockImplementation(async () => {
      await gate;
      return 1024;
    });

    const events = new AppEventEmitter();
    const diskSpace: string[] = [];
    events.on("setDiskSpace", (value: string) => diskSpace.push(value));
    const ui = new InteractiveUIService([makePlainService("repo-a")], undefined, undefined, 2, events);

    const header = ui.calculateAndUpdateDiskSpace();
    const view = ui.getRepositoryDiskUsage(0);
    release?.();
    const [, usage] = await Promise.all([header, view]);

    expect(mocks.directorySizes).toHaveBeenCalledTimes(2);
    expect(usage.sizeBytes).toBe(2048);
    expect(diskSpace).toEqual(["2.00 KB"]);
  });

  it("rebuilds the header total from fresh walks, so freed space shows up at once", async () => {
    const events = new AppEventEmitter();
    const diskSpace: string[] = [];
    events.on("setDiskSpace", (value: string) => diskSpace.push(value));
    const ui = new InteractiveUIService([makePlainService("repo-a")], undefined, undefined, 2, events);

    await ui.calculateAndUpdateDiskSpace();
    mocks.directorySizes.mockImplementation(() => Promise.resolve(0));
    await ui.calculateAndUpdateDiskSpace();

    expect(diskSpace).toEqual(["2.00 KB", "0 B"]);
    expect(mocks.directorySizes).toHaveBeenCalledTimes(4);
  });

  it("serves the status view from the walk the header total just did", async () => {
    const ui = new InteractiveUIService([makePlainService("repo-a")], undefined, undefined, 2, new AppEventEmitter());

    await ui.calculateAndUpdateDiskSpace();
    const callsAfterHeader = mocks.directorySizes.mock.calls.length;
    const usage = await ui.getRepositoryDiskUsage(0);

    expect(callsAfterHeader).toBe(2);
    expect(mocks.directorySizes).toHaveBeenCalledTimes(2);
    expect(usage.sizeBytes).toBe(2048);
  });

  it("bounds the disk walks by the repository parallelism it was given", async () => {
    // Counted from inside the fake, so this is what actually overlapped. The
    // bound must come from the parallelism setting and not from a display one:
    // lengthening a progress pane must never widen disk I/O.
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    mocks.directorySizes.mockImplementation(() => {
      inFlight += 1;
      if (inFlight > peak) peak = inFlight;
      return new Promise<number>((resolve) => {
        release.push(() => {
          inFlight -= 1;
          resolve(1024);
        });
      });
    });

    const ui = new InteractiveUIService(
      [makePlainService("repo-a"), makePlainService("repo-b"), makePlainService("repo-c")],
      undefined,
      undefined,
      3,
      new AppEventEmitter(),
    );

    // Six directories -- three bare, three worktree -- through a bound of three.
    const total = ui.calculateAndUpdateDiskSpace();
    for (let tick = 0; tick < 8; tick++) await Promise.resolve();
    expect(peak).toBe(3);

    for (let round = 0; round < 6; round++) {
      for (const done of release.splice(0)) done();
      for (let tick = 0; tick < 8; tick++) await Promise.resolve();
    }
    await total;

    expect(peak).toBe(3);
    expect(mocks.directorySizes).toHaveBeenCalledTimes(6);
  });

  it("still reports N/A when every directory of a repository fails to measure", async () => {
    mocks.directorySizes.mockImplementation(() => Promise.reject(new Error("du: cannot read directory")));
    const ui = new InteractiveUIService([makePlainService("repo-a")], undefined, undefined, 2, new AppEventEmitter());

    const usage = await ui.getRepositoryDiskUsage(0);

    expect(usage.sizeBytes).toBeNull();
    expect(usage.sizeFormatted).toBe("N/A");
    expect(usage.error).toContain("du: cannot read directory");
  });
});

describe(".diverged directory sizes", () => {
  let root: string;

  beforeEach(async () => {
    mocks.directorySizes.mockClear();
    mocks.directorySizes.mockImplementation(() => Promise.resolve(1024));
    root = await fs.mkdtemp(path.join(os.tmpdir(), "t25-diverged-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function makeDivergedService(): WorktreeSyncService {
    return {
      config: {
        name: "repo-a",
        repoUrl: "https://github.com/test/repo-a.git",
        worktreeDir: root,
        bareRepoDir: path.join(root, "bare"),
      } as unknown as Config,
      isInitialized: () => true,
      isSyncInProgress: () => false,
      clearRecordedSkips: vi.fn(),
      getRecordedSkips: () => [],
      updateLogger: vi.fn(),
      onProgress: vi.fn(() => () => undefined),
      getGitService: () => ({ getWorktrees: vi.fn(() => Promise.resolve([])) }),
      getWorktrees: () => Promise.resolve([]),
      discardDivergedDirectory: vi.fn((target: string) => fs.rm(target, { recursive: true, force: true })),
    } as unknown as WorktreeSyncService;
  }

  it("measures a .diverged directory through the cache the header shares", async () => {
    const diverged = path.join(root, ".diverged", "2026-01-01-feature");
    await fs.mkdir(diverged, { recursive: true });
    const ui = new InteractiveUIService([makeDivergedService()], undefined, undefined, 2, new AppEventEmitter());

    const first = await ui.getDivergedDirectoriesForRepo(0);
    const second = await ui.getDivergedDirectoriesForRepo(0);

    // Two opens, one walk: the listing used to walk every `.diverged/`
    // directory again on each open, and all of them at once besides.
    expect(first.map((entry) => entry.sizeBytes)).toEqual([1024]);
    expect(second.map((entry) => entry.sizeBytes)).toEqual([1024]);
    expect(mocks.directorySizes.mock.calls.map((call) => call[0])).toEqual([diverged]);
  });

  it("re-measures the repository after a diverged directory is deleted", async () => {
    const name = "2026-01-01-feature";
    const diverged = path.join(root, ".diverged", name);
    await fs.mkdir(diverged, { recursive: true });
    const ui = new InteractiveUIService([makeDivergedService()], undefined, undefined, 2, new AppEventEmitter());
    const bare = path.join(root, "bare");

    await ui.getRepositoryDiskUsage(0);
    await ui.getDivergedDirectoriesForRepo(0);
    await ui.deleteDivergedDirectory(0, name);
    const usage = await ui.getRepositoryDiskUsage(0);
    const remaining = await ui.getDivergedDirectoriesForRepo(0);

    expect(remaining).toEqual([]);
    expect(usage.sizeBytes).toBe(2048);
    // The worktree directory is walked again because the deletion shrank it --
    // without that the view showed the old total for a whole TTL, across
    // closing and reopening the modal. The bare repository, which the deletion
    // did not touch, is still served from cache.
    expect(mocks.directorySizes.mock.calls.map((call) => call[0])).toEqual([bare, root, diverged, root]);
  });
});
