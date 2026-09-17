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

// Ceiling on the item events one phase — or one stage of a phase — reports.
// Every item reports while a stage stays at or below it, which is what a
// normal repository and every test hits; past it the stage samples every
// step-th item so that a repository with thousands of branches cannot turn a
// single sync into thousands of TUI re-renders (every event re-renders the
// status bar) and MCP notifications. The first and the last item always
// report — the first because a 5,000-branch create phase would otherwise show
// its opening message until item 50, which is the very thing the counts exist
// to replace, and the last so a stage still ends on processed === total — so a
// stage reports at most one event more than this.
const MAX_PHASE_ITEM_EVENTS = 100;

/**
 * Counts the items one phase finished and reports `<label>: 'item' (i/n)`
 * with the counts attached, so consumers can show a moving number instead of
 * the phase's opening message for the whole phase.
 *
 * Call the returned function once per item, where that item's work *finished*
 * rather than where it was dispatched: phases run their items concurrently, so
 * counting completions is what keeps the reported sequence moving forward. The
 * counter is read and written with nothing awaited in between, so concurrent
 * callers cannot interleave and every event carries a higher `processed` than
 * the event before it.
 */
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
    // Callers hang this off the item's own promise, so a throw from here would
    // turn a finished item into a failed one — a prune status check that
    // "failed" and a removal skipped for it. Reporting can never do that.
    try {
      emitter.emit({ phase, message: `${label}: '${item}' (${processed}/${total})`, processed, total });
    } catch {
      // Progress reporting must not break sync flow.
    }
  };
}
