export interface ProgressEvent {
  phase: string;
  message: string;
  progress?: number;
  processed?: number;
  total?: number;
}

export type ProgressListener = (event: ProgressEvent) => void;

export class ProgressEmitter {
  private listeners = new Set<ProgressListener>();

  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ProgressEvent): void {
    // Snapshot so a listener that unsubscribes a sibling during emit doesn't
    // skip that sibling's notification for this event.
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Progress listeners must not break sync flow.
      }
    }
  }
}
