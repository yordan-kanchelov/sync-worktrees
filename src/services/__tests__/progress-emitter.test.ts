import { describe, expect, it, vi } from "vitest";

import { ProgressEmitter, trackPhaseItems } from "../progress-emitter";

import type { ProgressEvent } from "../progress-emitter";

describe("ProgressEmitter", () => {
  it("emits events to registered listeners", () => {
    const emitter = new ProgressEmitter();
    const listener = vi.fn();

    emitter.onProgress(listener);
    emitter.emit({ phase: "fetch", message: "Fetching" });

    expect(listener).toHaveBeenCalledWith({ phase: "fetch", message: "Fetching" });
  });

  it("unsubscribes listeners", () => {
    const emitter = new ProgressEmitter();
    const listener = vi.fn();
    const unsubscribe = emitter.onProgress(listener);

    unsubscribe();
    emitter.emit({ phase: "fetch", message: "Fetching" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("swallows listener errors and continues emitting", () => {
    const emitter = new ProgressEmitter();
    const listener = vi.fn();

    emitter.onProgress(() => {
      throw new Error("listener failed");
    });
    emitter.onProgress(listener);

    expect(() => emitter.emit({ phase: "fetch", message: "Fetching" })).not.toThrow();
    expect(listener).toHaveBeenCalledWith({ phase: "fetch", message: "Fetching" });
  });
});

describe("trackPhaseItems", () => {
  function collect(): { emitter: ProgressEmitter; events: ProgressEvent[] } {
    const emitter = new ProgressEmitter();
    const events: ProgressEvent[] = [];
    emitter.onProgress((event) => events.push(event));
    return { emitter, events };
  }

  it("reports every item of a phase small enough to report item by item", () => {
    const { emitter, events } = collect();
    const itemDone = trackPhaseItems(emitter, "create", "Creating worktrees", 3);

    itemDone("feature-1");
    itemDone("feature-2");
    itemDone("feature-3");

    expect(events).toEqual([
      { phase: "create", message: "Creating worktrees: 'feature-1' (1/3)", processed: 1, total: 3 },
      { phase: "create", message: "Creating worktrees: 'feature-2' (2/3)", processed: 2, total: 3 },
      { phase: "create", message: "Creating worktrees: 'feature-3' (3/3)", processed: 3, total: 3 },
    ]);
  });

  // A repository with thousands of branches must not turn one phase into
  // thousands of TUI re-renders and MCP notifications.
  it("samples a phase with thousands of items and still finishes on the total", () => {
    const { emitter, events } = collect();
    const itemDone = trackPhaseItems(emitter, "create", "Creating worktrees", 5000);

    for (let item = 1; item <= 5000; item++) itemDone(`branch-${item}`);

    expect(events.length).toBeLessThanOrEqual(101);
    expect(events.length).toBeGreaterThan(1);
    const processed = events.map((event) => event.processed!);
    expect(processed).toEqual([...processed].sort((a, b) => a - b));
    expect(new Set(processed).size).toBe(processed.length);
    expect(events.at(-1)).toMatchObject({ processed: 5000, total: 5000 });
    expect(events.every((event) => event.total === 5000)).toBe(true);
  });

  // Sampling must not swallow the beginning of the phase: waiting for item 50
  // to say anything leaves the opening message standing for exactly the kind of
  // long serial phase the counts were added for.
  it("reports the first item of a sampled phase, not just every step-th one", () => {
    const { emitter, events } = collect();
    const itemDone = trackPhaseItems(emitter, "create", "Creating worktrees", 5000);

    itemDone("branch-1");

    expect(events).toEqual([
      { phase: "create", message: "Creating worktrees: 'branch-1' (1/5000)", processed: 1, total: 5000 },
    ]);
  });

  // Callers hang this off the item's own promise, so a throw here would turn a
  // finished item into a failed one.
  it("never throws out of the item callback", () => {
    const emitter = {
      emit: () => {
        throw new Error("emit failed");
      },
    } as unknown as ProgressEmitter;
    const itemDone = trackPhaseItems(emitter, "prune", "Checking worktrees to prune", 2);

    expect(() => itemDone("gone-1")).not.toThrow();
    expect(() => itemDone("gone-2")).not.toThrow();
  });

  it("counts nothing until an item finishes", () => {
    const { emitter, events } = collect();
    trackPhaseItems(emitter, "prune", "Pruning stale worktrees", 4);

    expect(events).toEqual([]);
  });
});
