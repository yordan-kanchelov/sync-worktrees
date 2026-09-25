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

type AppEventMap = {
  updateLastSyncTime: void;
  setStatus: "idle" | "syncing";
  setSyncProgress: AppSyncProgress | null;
  setDiskSpace: string;
  addLog: { message: string; level: "info" | "warn" | "error" };
  uiReady: void;
  updateRepositoryCount: number;
  updateCronSchedule: string | undefined;
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
