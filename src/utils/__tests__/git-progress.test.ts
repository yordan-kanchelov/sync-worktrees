import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeGitProgressHandler } from "../git-progress";

import type { Logger } from "../../services/logger.service";
import type { SimpleGitProgressEvent } from "simple-git";

function makeEvent(
  method: string,
  stage: string,
  progress: number,
  processed = progress,
  total = 100,
): SimpleGitProgressEvent {
  return { method, stage, progress, processed, total } as SimpleGitProgressEvent;
}

describe("makeGitProgressHandler", () => {
  let infoSpy: ReturnType<typeof vi.fn>;
  let logger: Logger;

  beforeEach(() => {
    infoSpy = vi.fn();
    logger = { info: infoSpy, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  });

  it("filters out events for non-clone/fetch/pull methods", () => {
    const handler = makeGitProgressHandler(logger);
    handler(makeEvent("push", "Counting", 50));
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it.each(["clone", "fetch", "pull"] as const)("emits events for method '%s'", (method) => {
    const handler = makeGitProgressHandler(logger);
    handler(makeEvent(method, "Receiving objects", 100));
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining(`${method} Receiving objects: 100%`));
  });

  it("emits at most once per (method,stage) bucket of PROGRESS_BUCKET_PERCENT (25%)", () => {
    const handler = makeGitProgressHandler(logger);
    handler(makeEvent("fetch", "Compressing", 10));
    handler(makeEvent("fetch", "Compressing", 20));
    handler(makeEvent("fetch", "Compressing", 24));
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  it("emits on bucket boundary crossings", () => {
    const handler = makeGitProgressHandler(logger);
    handler(makeEvent("fetch", "Compressing", 10));
    handler(makeEvent("fetch", "Compressing", 30));
    handler(makeEvent("fetch", "Compressing", 55));
    handler(makeEvent("fetch", "Compressing", 80));
    expect(infoSpy).toHaveBeenCalledTimes(4);
  });

  it("always emits at 100% even if already emitted in the same bucket", () => {
    const handler = makeGitProgressHandler(logger);
    handler(makeEvent("clone", "Receiving objects", 76));
    handler(makeEvent("clone", "Receiving objects", 100));
    expect(infoSpy).toHaveBeenCalledTimes(2);
    expect(infoSpy).toHaveBeenLastCalledWith(expect.stringContaining("100%"));
  });

  it("resets bucket on stage restart (bucket regression) so the new run logs from scratch", () => {
    const handler = makeGitProgressHandler(logger);
    handler(makeEvent("fetch", "Receiving objects", 100));
    infoSpy.mockClear();

    // Second fetch on same cached SimpleGit instance: progress resets to 5%.
    handler(makeEvent("fetch", "Receiving objects", 5));
    handler(makeEvent("fetch", "Receiving objects", 30));
    expect(infoSpy).toHaveBeenCalledTimes(2);
  });

  it("tracks buckets independently per (method,stage) key", () => {
    const handler = makeGitProgressHandler(logger);
    handler(makeEvent("fetch", "Counting objects", 50));
    handler(makeEvent("fetch", "Compressing objects", 50));
    expect(infoSpy).toHaveBeenCalledTimes(2);
  });

  it("renders 'processed/total' when total > 0", () => {
    const handler = makeGitProgressHandler(logger);
    handler(makeEvent("fetch", "Counting objects", 50, 500, 1000));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("(500/1000)"));
  });

  it("renders 'processed' alone when total is 0", () => {
    const handler = makeGitProgressHandler(logger);
    handler(makeEvent("fetch", "Resolving deltas", 50, 7, 0));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("(7)"));
  });

  it("forwards throttled progress events to the optional emitter", () => {
    const emitProgress = vi.fn();
    const handler = makeGitProgressHandler(logger, emitProgress);

    handler(makeEvent("clone", "Receiving objects", 25, 5, 20));

    expect(emitProgress).toHaveBeenCalledWith({
      phase: "clone",
      message: "clone Receiving objects: 25% (5/20)",
      progress: 25,
      processed: 5,
      total: 20,
    });
  });
});
