type AppEventMap = {
  updateLastSyncTime: void;
  setStatus: "idle" | "syncing";
  setDiskSpace: string;
  addLog: { message: string; level: "info" | "warn" | "error" };
};

type EventCallback<T> = T extends void ? () => void : (payload: T) => void;

type AnyEventCallback = EventCallback<AppEventMap[keyof AppEventMap]>;

class AppEventEmitter {
  private listeners: Map<keyof AppEventMap, Set<AnyEventCallback>> = new Map();

  on<K extends keyof AppEventMap>(event: K, callback: EventCallback<AppEventMap[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback as AnyEventCallback);

    return () => {
      this.listeners.get(event)?.delete(callback as AnyEventCallback);
    };
  }

  emit<K extends keyof AppEventMap>(event: K, ...args: AppEventMap[K] extends void ? [] : [AppEventMap[K]]): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          (callback as (payload?: AppEventMap[K]) => void)(args[0]);
        } catch {
          // Silently handle callback errors
        }
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}

export const appEvents = new AppEventEmitter();
