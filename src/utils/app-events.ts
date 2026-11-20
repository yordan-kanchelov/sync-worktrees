import { Logger } from "../services/logger.service";

import { redactSecretsInText } from "./git-url";

export interface AppSyncProgress {
  repo: string;
  phase: string;
  message: string;
  progress?: number;
  processed?: number;
  total?: number;
  completed?: boolean;
}

export type LastSyncOutcome = { kind: "ok" } | { kind: "failed"; count: number } | { kind: "skipped"; count: number };

export type CronScheduleDisplay = string | readonly string[] | undefined;

export type RepositoryRunState = "idle" | "syncing" | "failed" | "skipped";

export interface RepositoryDashboardRow {
  name: string;
  state: RepositoryRunState;
  lastResult: string | null;
  lastSyncAt: number | null;
  worktrees: number | null;
  changes: { dirty: number; unpushed: number } | null;
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
  updateMaxProgressLines: number;
  repositoriesReloaded: number;
  updateCronSchedule: CronScheduleDisplay;
};

function scrubPayload<T>(payload: T): T {
  if (typeof payload === "string") return redactSecretsInText(payload) as T;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  let scrubbed: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value !== "string") continue;
    const redacted = redactSecretsInText(value);
    if (redacted === value) continue;
    scrubbed ??= { ...(payload as Record<string, unknown>) };
    scrubbed[key] = redacted;
  }
  return (scrubbed ?? payload) as T;
}

type EventCallback<T> = T extends void ? () => void : (payload: T) => void;

type AnyEventCallback = EventCallback<AppEventMap[keyof AppEventMap]>;

export class AppEventEmitter {
  private listeners: Map<keyof AppEventMap, Set<AnyEventCallback>> = new Map();

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
      const payload = args.length > 0 ? scrubPayload(args[0]) : undefined;
      for (const callback of callbacks) {
        try {
          (callback as (payload?: AppEventMap[K]) => void)(payload);
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
