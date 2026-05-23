import { describe, expect, it, vi } from "vitest";

import { ProgressEmitter } from "../progress-emitter";

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
