import * as ink from "ink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppEventEmitter } from "../../utils/app-events";
import { calculateDirectorySize } from "../../utils/disk-space";
import { InteractiveUIService } from "../InteractiveUIService";
import { WorktreeSyncService } from "../worktree-sync.service";

import type { RepositoryConfig } from "../../types";
import type * as LoggerModule from "../logger.service";
import type { Mock } from "vitest";

// Lines the real service emits while initialize() runs, through sub-services
// that took their logger from the config when they were built: GitService's
// fetch announcement and a WorktreeStatusService probe failure.
const { INIT_INFO, INIT_ERROR, REPO_CONFIG, syncControl } = vi.hoisted(() => ({
  INIT_INFO: "Fetching remote branches...",
  INIT_ERROR: "Error reading status for /test/worktrees/feature",
  REPO_CONFIG: {
    name: "repo-a",
    repoUrl: "https://github.com/test/repo.git",
    worktreeDir: "/test/worktrees",
    cronSchedule: "0 * * * *",
    runOnce: false,
  },
  // Lets one test hold the reload's own sync open and see what a cycle landing
  // inside it touches. The gate is consumed by the first sync that meets it, so
  // a second cycle is never blocked by it.
  syncControl: { gate: undefined as Promise<void> | undefined, syncCalls: 0, clearCalls: 0 },
}));

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

      constructor(public config: RepositoryConfig) {
        // Mirrors WorktreeSyncService's own fallback, which passes no name.
        this.logger = config.logger ?? Logger.createDefault(undefined, config.debug);
      }

      updateLogger(logger: LoggerModule.Logger): void {
        this.logger = logger;
      }

      async initialize(): Promise<void> {
        this.initialized = true;
        this.logger.info(INIT_INFO);
        this.logger.error(INIT_ERROR);
      }

      isInitialized(): boolean {
        return this.initialized;
      }

      isSyncInProgress(): boolean {
        return false;
      }

      async sync(): Promise<unknown> {
        syncControl.syncCalls++;
        const gate = syncControl.gate;
        syncControl.gate = undefined;
        if (gate) await gate;
        return { started: true, outcome: { mode: "worktree", counts: { failed: 0, skipped: 0 } } };
      }

      onProgress(): () => void {
        return () => undefined;
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
      buildRepositories: vi.fn().mockResolvedValue({
        repositories: [{ ...REPO_CONFIG }],
        configFile: { repositories: [REPO_CONFIG] },
        configDir: "",
      }),
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
