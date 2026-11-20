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
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {}
    }
  }
}

const MAX_PHASE_ITEM_EVENTS = 100;

export function trackPhaseItems(
  emitter: ProgressEmitter,
  phase: string,
  label: string,
  total: number,
): (item: string) => void {
  const step = Math.max(1, Math.ceil(total / MAX_PHASE_ITEM_EVENTS));

  let processed = 0;
  return (item: string): void => {
    processed += 1;
    if (processed !== 1 && processed !== total && processed % step !== 0) return;
    try {
      emitter.emit({ phase, message: `${label}: '${item}' (${processed}/${total})`, processed, total });
    } catch {}
  };
}
