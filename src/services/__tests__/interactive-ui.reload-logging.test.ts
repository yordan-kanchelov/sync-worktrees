import * as ink from "ink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppEventEmitter } from "../../utils/app-events";
import { calculateDirectorySize } from "../../utils/disk-space";
import { InteractiveUIService } from "../InteractiveUIService";
import { WorktreeSyncService } from "../worktree-sync.service";

import type { AppSyncProgress } from "../../utils/app-events";
import type { RepositoryConfig } from "../../types";
import type * as LoggerModule from "../logger.service";
import type { Mock } from "vitest";

// Lines the real service emits while initialize() runs, through sub-services
// that took their logger from the config when they were built: GitService's
// fetch announcement and a WorktreeStatusService probe failure.
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
    // What initialize() reports through the progress emitter rather than the
    // logger: the clone that makes a reload take minutes.
    INIT_PROGRESS: "Cloning bare repository",
    // What sync() reports through the same emitter, once the reload has
    // swapped the services in and subscribed to them the usual way.
    SYNC_PROGRESS: "Updating worktrees",
    INIT_FAILURE: "Permission denied (publickey)",
    REPO_CONFIG,
    SECOND_REPO_CONFIG: {
      ...REPO_CONFIG,
      name: "repo-b",
      repoUrl: "https://github.com/test/second.git",
      worktreeDir: "/test/worktrees-b",
    },
    // Lets one test hold the reload's own sync open and see what a cycle landing
    // inside it touches. The gate is consumed by the first sync that meets it, so
    // a second cycle is never blocked by it.
    syncControl: {
      gate: undefined as Promise<void> | undefined,
      syncCalls: 0,
      clearCalls: 0,
      // What the config offers the next reload, and which of those repositories
      // initialize() rejects for.
      repositories: [REPO_CONFIG] as Array<typeof REPO_CONFIG>,
      failInit: new Set<string>(),
      // The reload's call sequence per service, in the order the services
      // reached each step.
      trace: [] as string[],
    },
  };
});

// Stands in for WorktreeSyncService with the one behaviour under test: the
// logger reaches every sub-service by being copied out of the config at
// construction, so whatever a service logs before the UI corrects it goes to
// the console — under Ink's alternate screen, over the interface.
vi.mock("../worktree-sync.service", async () => {
  const { Logger } = await vi.importActual<typeof LoggerModule>("../logger.service");
  return {
    WorktreeSyncService: class {
      private logger: LoggerModule.Logger;
      private initialized = false;
      private progressListeners = new Set<(event: { phase: string; message: string }) => void>();

      constructor(public config: RepositoryConfig) {
        // Recorded from the constructor rather than read off the config later:
        // the reload assigns the logger onto the very object it then hands the
        // constructor, so `config.logger` after the fact cannot tell a logger
        // that was there from one assigned once initialize() had already run.
        syncControl.trace.push(`${config.logger ? "logger" : "console"}:${config.name}`);
        // Mirrors WorktreeSyncService's own fallback, which passes no name.
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
        return [];
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
        configFile: { repositories: syncControl.repositories },
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
    // Scope the console spies to the reload itself: rendering the Ink tree in
    // the constructor has warnings of its own (React's JSX transform notice).
    for (const method of [console.log, console.warn, console.error]) {
      (method as unknown as Mock).mockClear();
    }
    // Same for the trace: the UI's own constructor injects a logger into the
    // service it was handed, which is not part of any reload's sequence.
    syncControl.trace = [];
    const onReload = ((ink.render as unknown as Mock).mock.calls[0][0].props as { onReload: () => Promise<void> })
      .onReload;
    await onReload();
  };

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

  // The order is the whole of it, and it is what the earlier test of this could
  // not see: the reload assigns the logger onto the same config object it hands
  // the constructor, so a version that assigned it after initialize() still
  // leaves a logger on the object an "was it injected?" assertion reads. Only
  // the sequence separates the two, and it has to hold for every repository the
  // reload builds, not just the first.
  it("gives every reloaded service its panel logger before that service initializes", async () => {
    syncControl.repositories = [REPO_CONFIG, SECOND_REPO_CONFIG];

    await reload();

    expect(syncControl.trace).toEqual(["logger:repo-a", "initialize:repo-a", "logger:repo-b", "initialize:repo-b"]);
  });

  // initialize() is the long part of a reload -- a bare clone of a repository
  // just added to the config -- and it reports through the progress emitter,
  // not the logger. Subscribing only once every initialize() had resolved threw
  // away exactly the progress the user is waiting on.
  it("shows the progress a reloaded service reports while it is initializing", async () => {
    const progress: AppSyncProgress[] = [];
    events.on("setSyncProgress", (event: AppSyncProgress | null) => {
      if (event) progress.push(event);
    });

    await reload();

    expect(progress).toContainEqual(expect.objectContaining({ repo: "repo-a", message: INIT_PROGRESS }));
  });

  // The subscription taken for initialize() is a second one on a service that
  // subscribeToServiceProgress() is about to watch anyway, so it has to be
  // dropped when initialize() settles. Left in place, every reload leaves one
  // more listener on each surviving service and each of that service's progress
  // events is reported once more than it happened.
  it("reports a reloaded service's progress once after the reload, not once per reload it survived", async () => {
    const progress: AppSyncProgress[] = [];
    events.on("setSyncProgress", (event: AppSyncProgress | null) => {
      if (event) progress.push(event);
    });

    await reload();

    expect(syncControl.syncCalls).toBe(1);
    expect(progress.filter((event) => event.message === SYNC_PROGRESS)).toHaveLength(1);
  });

  // Six repositories initializing in parallel and one revoked deploy key: the
  // rejection carries the git error, never the repository it came from, and the
  // index into the list handed to Promise.allSettled is the only thing that
  // does.
  it("names the repository whose initialization failed", async () => {
    syncControl.repositories = [REPO_CONFIG, SECOND_REPO_CONFIG];
    syncControl.failInit = new Set(["repo-b"]);

    await reload();

    const failure = panelLogs.find((line) => line.startsWith("Failed to initialize repository"));
    expect(failure).toContain("'repo-b'");
    expect(failure).toContain(INIT_FAILURE);
  });

  // A reload runs a sync of its own, so it is one more cycle the status bar has
  // to account for. Both of its `idle`s used to be unconditional, so a cycle
  // that finished inside a reload (an overlapping cron tick) put the interface
  // back to "Running" and blanked the progress panel while the reload was still
  // initializing repositories.
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

  // The invariant this change asserts -- a cycle never reaches
  // clearRecordedSkips() for a repository another cycle is syncing -- has to
  // hold for the reload too, and the reload is the one cycle that always syncs
  // every repository. It arms the new cron jobs and only then runs its sync, so
  // a tick landing in that window is routine; it used to call runSyncServices
  // directly, outside the claim, and wipe the reload's accumulator.
  it("keeps an overlapping cycle out of the repositories the reload is syncing", async () => {
    let release!: () => void;
    syncControl.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const onReload = ((ink.render as unknown as Mock).mock.calls[0][0].props as { onReload: () => Promise<void> })
      .onReload;
    const reloading = onReload();
    // Wait until the reload is inside its own sync, holding the repository.
    await vi.waitFor(() => expect(syncControl.syncCalls).toBe(1));
    const clearsWhileTheReloadOwnsIt = syncControl.clearCalls;

    // What a tick, or an `s`, does while that sync is in flight. The claim is
    // taken before the cycle's first await, so starting it here is enough --
    // the reload is then let go, because the parallelism limit is 1 and the
    // losing cycle otherwise queues behind it rather than reporting anything.
    const tick = uiService.triggerInitialSync();
    release();
    await Promise.all([tick, reloading]);

    expect(syncControl.syncCalls).toBe(1);
    expect(syncControl.clearCalls).toBe(clearsWhileTheReloadOwnsIt);
    expect(panelLogs).toContain("A sync is already running; skipping this cycle.");
  });

  it("measures the repository again after a reload rather than serving the cached size", async () => {
    // The reload's initialize() can clone a bare repository or lay down
    // worktrees, and a cycle in which every repository is skipped never
    // rebuilds the header total -- so the sizes the status view holds for these
    // paths cannot be carried across it. Same paths on both sides: what is
    // being pinned is the invalidation, not a change of key.
    const measured = vi.mocked(calculateDirectorySize);

    await uiService.getRepositoryDiskUsage(0);
    const walkedBeforeReload = measured.mock.calls.map((call) => call[0]);

    await reload();
    await uiService.getRepositoryDiskUsage(0);

    expect(walkedBeforeReload).toHaveLength(2);
    expect(measured.mock.calls.map((call) => call[0])).toEqual([...walkedBeforeReload, ...walkedBeforeReload]);
  });
});
