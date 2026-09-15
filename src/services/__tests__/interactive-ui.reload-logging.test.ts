import * as ink from "ink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppEventEmitter } from "../../utils/app-events";
import { InteractiveUIService } from "../InteractiveUIService";
import { WorktreeSyncService } from "../worktree-sync.service";

import type { RepositoryConfig } from "../../types";
import type * as LoggerModule from "../logger.service";
import type { Mock } from "vitest";

// Lines the real service emits while initialize() runs, through sub-services
// that took their logger from the config when they were built: GitService's
// fetch announcement and a WorktreeStatusService probe failure.
const { INIT_INFO, INIT_ERROR, REPO_CONFIG } = vi.hoisted(() => ({
  INIT_INFO: "Fetching remote branches...",
  INIT_ERROR: "Error reading status for /test/worktrees/feature",
  REPO_CONFIG: {
    name: "repo-a",
    repoUrl: "https://github.com/test/repo.git",
    worktreeDir: "/test/worktrees",
    cronSchedule: "0 * * * *",
    runOnce: false,
  },
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
        return { started: true, outcome: { mode: "worktree", counts: { failed: 0, skipped: 0 } } };
      }

      onProgress(): () => void {
        return () => undefined;
      }

      getRecordedSkips(): unknown[] {
        return [];
      }

      clearRecordedSkips(): void {}
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
    (ink.render as unknown as Mock).mockReturnValue({ unmount: vi.fn() });

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
});
