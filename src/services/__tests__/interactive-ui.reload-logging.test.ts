import * as ink from "ink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppEventEmitter } from "../../utils/app-events";
import { calculateDirectorySize } from "../../utils/disk-space";
import { InteractiveUIService } from "../InteractiveUIService";
import { WorktreeSyncService } from "../worktree-sync.service";

import type { AppSyncProgress } from "../../utils/app-events";
import type { RepositoryConfig } from "../../types";
import type * as LoggerModule from "../logger.service";
import type { LimitFunction } from "p-limit";
import type { Mock } from "vitest";

const {
  INIT_INFO,
  INIT_ERROR,
  INIT_PROGRESS,
  SYNC_PROGRESS,
  INIT_FAILURE,
  REPO_CONFIG,
  SECOND_REPO_CONFIG,
  syncControl,
} = vi.hoisted(() => {
  const REPO_CONFIG = {
    name: "repo-a",
    repoUrl: "https://github.com/test/repo.git",
    worktreeDir: "/test/worktrees",
    cronSchedule: "0 * * * *",
    runOnce: false,
  };
  return {
    INIT_INFO: "Fetching remote branches...",
    INIT_ERROR: "Error reading status for /test/worktrees/feature",
    INIT_PROGRESS: "Cloning bare repository",
    SYNC_PROGRESS: "Updating worktrees",
    INIT_FAILURE: "Permission denied (publickey)",
    REPO_CONFIG,
    SECOND_REPO_CONFIG: {
      ...REPO_CONFIG,
      name: "repo-b",
      repoUrl: "https://github.com/test/second.git",
      worktreeDir: "/test/worktrees-b",
    },
    syncControl: {
      gate: undefined as Promise<void> | undefined,
      syncCalls: 0,
      clearCalls: 0,
      repositories: [REPO_CONFIG] as Array<typeof REPO_CONFIG>,
      failInit: new Set<string>(),
      trace: [] as string[],
      recordedSkips: [] as unknown[],
      parallelism: undefined as { maxRepositories?: number } | undefined,
      defaults: undefined as { parallelism?: { maxRepositories?: number } } | undefined,
    },
  };
});

vi.mock("../worktree-sync.service", async () => {
  const { Logger } = await vi.importActual<typeof LoggerModule>("../logger.service");
  return {
    WorktreeSyncService: class {
      private logger: LoggerModule.Logger;
      private initialized = false;
      private progressListeners = new Set<(event: { phase: string; message: string }) => void>();

      constructor(public config: RepositoryConfig) {
        syncControl.trace.push(`${config.logger ? "logger" : "console"}:${config.name}`);
        this.logger = config.logger ?? Logger.createDefault(undefined, config.debug);
      }

      updateLogger(logger: LoggerModule.Logger): void {
        syncControl.trace.push(`updateLogger:${this.config.name}`);
        this.logger = logger;
      }

      async initialize(): Promise<void> {
        syncControl.trace.push(`initialize:${this.config.name}`);
        this.initialized = true;
        for (const listener of this.progressListeners) {
          listener({ phase: "initialize", message: INIT_PROGRESS });
        }
        this.logger.info(INIT_INFO);
        this.logger.error(INIT_ERROR);
        if (syncControl.failInit.has(this.config.name)) {
          throw new Error(INIT_FAILURE);
        }
      }

      isInitialized(): boolean {
        return this.initialized;
      }

      isSyncInProgress(): boolean {
        return false;
      }

      async sync(): Promise<unknown> {
        syncControl.syncCalls++;
        for (const listener of this.progressListeners) {
          listener({ phase: "sync", message: SYNC_PROGRESS });
        }
        const gate = syncControl.gate;
        syncControl.gate = undefined;
        if (gate) await gate;
        return { started: true, outcome: { mode: "worktree", counts: { failed: 0, skipped: 0 } } };
      }

      onProgress(listener: (event: { phase: string; message: string }) => void): () => void {
        this.progressListeners.add(listener);
        return () => {
          this.progressListeners.delete(listener);
        };
      }

      getRecordedSkips(): unknown[] {
        return syncControl.recordedSkips;
      }

      clearRecordedSkips(): void {
        syncControl.clearCalls++;
      }
    },
  };
});

vi.mock("../config-loader.service", () => ({
  ConfigLoaderService: vi.fn(function () {
    return {
      buildRepositories: vi.fn(async () => ({
        repositories: syncControl.repositories.map((repo) => ({ ...repo })),
        configFile: {
          repositories: syncControl.repositories,
          parallelism: syncControl.parallelism,
          defaults: syncControl.defaults,
        },
        configDir: "",
      })),
    };
  }),
}));

vi.mock("../../utils/disk-space", () => ({
  calculateSyncDiskSpace: vi.fn().mockResolvedValue({ totalSize: 0, formattedSize: "0 B" }),
  calculateDirectorySize: vi.fn().mockResolvedValue(0),
  formatBytes: vi.fn().mockReturnValue("0 B"),
}));

vi.mock("ink", () => ({ render: vi.fn() }));

describe("InteractiveUIService reload logging", () => {
  let events: AppEventEmitter;
  let panelLogs: string[];
  let uiService: InteractiveUIService;

  beforeEach(() => {
    vi.clearAllMocks();
    syncControl.gate = undefined;
    syncControl.syncCalls = 0;
    syncControl.clearCalls = 0;
    syncControl.repositories = [REPO_CONFIG];
    syncControl.failInit = new Set<string>();
    syncControl.trace = [];
    syncControl.recordedSkips = [];
    syncControl.parallelism = undefined;
    syncControl.defaults = undefined;
    (ink.render as unknown as Mock).mockReturnValue({
      unmount: vi.fn(),
      waitUntilExit: vi.fn(() => new Promise<void>(() => {})),
    });

    events = new AppEventEmitter();
    panelLogs = [];
    events.on("addLog", ({ message }) => panelLogs.push(message));

    uiService = new InteractiveUIService(
      [new WorktreeSyncService({ ...REPO_CONFIG } as RepositoryConfig)],
      "/test/sync-worktrees.config.js",
      "0 * * * *",
      1,
      events,
    );
    events.emit("uiReady");
  });

  afterEach(async () => {
    await uiService.destroy(true);
  });

  const reload = async (): Promise<void> => {
    for (const method of [console.log, console.warn, console.error]) {
      (method as unknown as Mock).mockClear();
    }
    syncControl.trace = [];
    const onReload = ((ink.render as unknown as Mock).mock.calls[0][0].props as { onReload: () => Promise<void> })
      .onReload;
    await onReload();
  };

  it("applies a changed parallelism.maxRepositories on reload", async () => {
    const internals = uiService as unknown as {
      limit: LimitFunction;
      diskUsage: { limit: LimitFunction };
    };
    const progressLines: number[] = [];
    events.on("updateMaxProgressLines", (lines: number) => progressLines.push(lines));
    expect(internals.limit.concurrency).toBe(1);

    syncControl.parallelism = { maxRepositories: 4 };
    await reload();
    expect(internals.limit.concurrency).toBe(4);
    expect(internals.diskUsage.limit.concurrency).toBe(4);
    expect(progressLines).toEqual([4]);

    syncControl.defaults = { parallelism: { maxRepositories: 2 } };
    await reload();
    expect(internals.limit.concurrency).toBe(2);
    expect(progressLines).toEqual([4, 2]);
  });

  it("initializes the reloaded services without writing to the console", async () => {
    await reload();

    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("sends what the reloaded services log to the log panel instead", async () => {
    await reload();

    expect(panelLogs).toContain(`[repo-a] ${INIT_INFO}`);
    expect(panelLogs).toContain(`[repo-a] ${INIT_ERROR}`);
  });

  it("gives every reloaded service its panel logger before that service initializes", async () => {
    syncControl.repositories = [REPO_CONFIG, SECOND_REPO_CONFIG];

    await reload();

    expect(syncControl.trace).toEqual(["logger:repo-a", "initialize:repo-a", "logger:repo-b", "initialize:repo-b"]);
  });

  it("shows the progress a reloaded service reports while it is initializing", async () => {
    const progress: AppSyncProgress[] = [];
    events.on("setSyncProgress", (event: AppSyncProgress | null) => {
      if (event) progress.push(event);
    });

    await reload();

    expect(progress).toContainEqual(expect.objectContaining({ repo: "repo-a", message: INIT_PROGRESS }));
  });

  it("reports a reloaded service's progress once after the reload, not once per reload it survived", async () => {
    const progress: AppSyncProgress[] = [];
    events.on("setSyncProgress", (event: AppSyncProgress | null) => {
      if (event) progress.push(event);
    });

    await reload();

    expect(syncControl.syncCalls).toBe(1);
    expect(progress.filter((event) => event.message === SYNC_PROGRESS)).toHaveLength(1);
  });

  it("names the repository whose initialization failed", async () => {
    syncControl.repositories = [REPO_CONFIG, SECOND_REPO_CONFIG];
    syncControl.failInit = new Set(["repo-b"]);

    await reload();

    const failure = panelLogs.find((line) => line.startsWith("Failed to initialize repository"));
    expect(failure).toContain("'repo-b'");
    expect(failure).toContain(INIT_FAILURE);
  });

  it("never shows the credentials of a repository configured without a name", async () => {
    const rawUrl = "https://ci-bot:s3cr3t-token@github.com/test/repo.git";
    const redactedUrl = "https://***@github.com/test/repo.git";
    syncControl.repositories = [{ ...REPO_CONFIG, name: undefined as unknown as string, repoUrl: rawUrl }];
    syncControl.recordedSkips = [
      { kind: "branch_mismatch", phase: "init", currentBranch: "dev", expectedBranch: "main" },
    ];
    const progress: AppSyncProgress[] = [];
    events.on("setSyncProgress", (event: AppSyncProgress | null) => {
      if (event) progress.push(event);
    });

    await reload();

    expect(progress).toContainEqual(expect.objectContaining({ repo: redactedUrl, message: INIT_PROGRESS }));
    expect(panelLogs).toContainEqual(expect.stringContaining(`Clone-mode skip for '${redactedUrl}'`));
    expect(JSON.stringify(progress)).not.toContain("s3cr3t-token");
    expect(panelLogs.join("\n")).not.toContain("s3cr3t-token");
  });

  it("keeps the status at syncing while a sync cycle overlaps the reload", async () => {
    const statuses: Array<"idle" | "syncing"> = [];
    events.on("setStatus", (status: "idle" | "syncing") => statuses.push(status));

    const onReload = ((ink.render as unknown as Mock).mock.calls[0][0].props as { onReload: () => Promise<void> })
      .onReload;

    const reloading = onReload();
    const cycle = uiService.triggerInitialSync();
    await Promise.all([cycle, reloading]);

    expect(statuses).toEqual(["syncing", "idle"]);
  });

  it("keeps an overlapping cycle out of the repositories the reload is syncing", async () => {
    let release!: () => void;
    syncControl.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const onReload = ((ink.render as unknown as Mock).mock.calls[0][0].props as { onReload: () => Promise<void> })
      .onReload;
    const reloading = onReload();
    await vi.waitFor(() => expect(syncControl.syncCalls).toBe(1));
    const clearsWhileTheReloadOwnsIt = syncControl.clearCalls;

    const tick = uiService.triggerInitialSync();
    release();
    await Promise.all([tick, reloading]);

    expect(syncControl.syncCalls).toBe(1);
    expect(syncControl.clearCalls).toBe(clearsWhileTheReloadOwnsIt);
    expect(panelLogs).toContain("A sync is already running; skipping this cycle.");
  });

  it("measures the repository again after a reload rather than serving the cached size", async () => {
    const measured = vi.mocked(calculateDirectorySize);

    await uiService.operations.getRepositoryDiskUsage(0);
    const walkedBeforeReload = measured.mock.calls.map((call) => call[0]);

    await reload();
    await uiService.operations.getRepositoryDiskUsage(0);

    expect(walkedBeforeReload).toHaveLength(2);
    expect(measured.mock.calls.map((call) => call[0])).toEqual([...walkedBeforeReload, ...walkedBeforeReload]);
  });
});
