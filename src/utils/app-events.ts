import { Logger } from "../services/logger.service";

export interface AppSyncProgress {
  repo: string;
  phase: string;
  message: string;
  progress?: number;
  processed?: number;
  total?: number;
  completed?: boolean;
}

// How the most recent cycle ended, so the status bar can say "2 failed"
// instead of leaving a fresh "Last Sync" time to imply that everything worked.
export type LastSyncOutcome = { kind: "ok" } | { kind: "failed"; count: number } | { kind: "skipped"; count: number };

// One schedule, or every distinct schedule the repositories run on. The status
// bar shows the earliest next run across all of them.
export type CronScheduleDisplay = string | readonly string[] | undefined;

// One row of the home screen's repository table. The service sends the whole
// table whenever a row changes; the App renders it and never asks git itself.
export type RepositoryRunState = "idle" | "syncing" | "failed" | "skipped";

export interface RepositoryDashboardRow {
  name: string;
  state: RepositoryRunState;
  /** How the last sync of this repository went, in a few words; null until one has finished. */
  lastResult: string | null;
  /** When a sync of this repository last ran to an end (epoch ms). A skip leaves it where it was. */
  lastSyncAt: number | null;
  /** Worktrees the repository had after its last sync or status check; null until known. */
  worktrees: number | null;
  /**
   * Worktrees with uncommitted changes and with unpushed commits, as of the
   * last time the status view (`w`) checked this repository; null until then.
   */
  changes: { dirty: number; unpushed: number } | null;
  /** The cron expression this repository runs on; absent for `runOnce` or no schedule. */
  schedule?: string;
}

type AppEventMap = {
  setRepositoryDashboard: readonly RepositoryDashboardRow[];
  updateLastSyncTime: void;
  setLastSyncOutcome: LastSyncOutcome;
  setStatus: "idle" | "syncing";
  setSyncProgress: AppSyncProgress | null;
  setDiskSpace: string;
  addLog: { message: string; level: "info" | "warn" | "error" };
  uiReady: void;
  updateRepositoryCount: number;
  updateCronSchedule: CronScheduleDisplay;
};

type EventCallback<T> = T extends void ? () => void : (payload: T) => void;

type AnyEventCallback = EventCallback<AppEventMap[keyof AppEventMap]>;

export class AppEventEmitter {
  private listeners: Map<keyof AppEventMap, Set<AnyEventCallback>> = new Map();

  // A throwing listener is reported, never rethrown into the emitter's caller.
  // It goes through the redacting logger: a listener's error can quote a
  // repository URL with credentials in it.
  constructor(private readonly logger: Pick<Logger, "error"> = Logger.createDefault()) {}

  on<K extends keyof AppEventMap>(event: K, callback: EventCallback<AppEventMap[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    return () => {
      const set = this.listeners.get(event);
      if (set) {
        set.delete(callback);
        if (set.size === 0) {
          this.listeners.delete(event);
        }
      }
    };
  }

  emit<K extends keyof AppEventMap>(event: K, ...args: AppEventMap[K] extends void ? [] : [AppEventMap[K]]): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          (callback as (payload?: AppEventMap[K]) => void)(args[0]);
        } catch (error) {
          this.logger.error(`[app-events] Error in '${String(event)}' listener:`, error);
        }
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
