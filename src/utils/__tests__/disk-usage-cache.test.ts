import { describe, expect, it } from "vitest";

import { DISK_USAGE_CACHE_TTL_MS, DiskUsageCache } from "../disk-usage-cache";

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function recorder(sizes: number[] = []): {
  measure: (dirPath: string) => Promise<number>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    measure: (dirPath: string) => {
      calls.push(dirPath);
      return Promise.resolve(sizes[calls.length - 1] ?? 100);
    },
  };
}

function gatedRecorder(): {
  measure: (dirPath: string) => Promise<number>;
  calls: string[];
  inFlight: () => number;
  peak: () => number;
  release: () => Promise<void>;
} {
  const calls: string[] = [];
  const gates: Array<() => void> = [];
  let inFlight = 0;
  let peak = 0;
  return {
    calls,
    inFlight: () => inFlight,
    peak: () => peak,
    release: async () => {
      for (const gate of gates.splice(0)) gate();
      for (let tick = 0; tick < 4; tick++) await Promise.resolve();
    },
    measure: (dirPath: string) => {
      calls.push(dirPath);
      inFlight += 1;
      if (inFlight > peak) peak = inFlight;
      return new Promise<number>((resolve) => {
        gates.push(() => {
          inFlight -= 1;
          resolve(100);
        });
      });
    },
  };
}

function gatedSizes(sizes: number[]): {
  measure: (dirPath: string) => Promise<number>;
  calls: string[];
  release: (index: number) => Promise<void>;
} {
  const calls: string[] = [];
  const gates: Array<(bytes: number) => void> = [];
  return {
    calls,
    release: async (index: number) => {
      gates[index](sizes[index]);
      for (let tick = 0; tick < 4; tick++) await Promise.resolve();
    },
    measure: (dirPath: string) => {
      calls.push(dirPath);
      return new Promise<number>((resolve) => {
        gates.push(resolve);
      });
    },
  };
}

const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 4; tick++) await Promise.resolve();
};

describe("DiskUsageCache", () => {
  it("reuses a measurement taken inside the TTL", async () => {
    const time = clock();
    const probe = recorder();
    const cache = new DiskUsageCache(4, DISK_USAGE_CACHE_TTL_MS, probe.measure, time.now);

    expect(await cache.size("/a")).toBe(100);
    time.advance(DISK_USAGE_CACHE_TTL_MS - 1);

    expect(await cache.size("/a")).toBe(100);
    expect(probe.calls).toEqual(["/a"]);
  });

  it("walks again once the TTL has elapsed", async () => {
    const time = clock();
    const probe = recorder([100, 250]);
    const cache = new DiskUsageCache(4, DISK_USAGE_CACHE_TTL_MS, probe.measure, time.now);

    await cache.size("/a");
    time.advance(DISK_USAGE_CACHE_TTL_MS);

    expect(await cache.size("/a")).toBe(250);
    expect(probe.calls).toEqual(["/a", "/a"]);
  });

  it("stops serving a measurement after a minute", async () => {
    const time = clock();
    const probe = recorder([100, 250]);
    const cache = new DiskUsageCache(4, undefined, probe.measure, time.now);

    expect(await cache.size("/a")).toBe(100);
    time.advance(59_999);
    expect(await cache.size("/a")).toBe(100);

    time.advance(1);
    expect(await cache.size("/a")).toBe(250);
    expect(probe.calls).toEqual(["/a", "/a"]);
  });

  it("caches per directory, not globally", async () => {
    const time = clock();
    const probe = recorder([100, 200]);
    const cache = new DiskUsageCache(4, DISK_USAGE_CACHE_TTL_MS, probe.measure, time.now);

    expect(await Promise.all([cache.size("/a"), cache.size("/b")])).toEqual([100, 200]);
    expect(probe.calls).toEqual(["/a", "/b"]);
  });

  it("gives two callers waiting on the same directory one walk", async () => {
    const time = clock();
    const probe = gatedRecorder();
    const cache = new DiskUsageCache(4, DISK_USAGE_CACHE_TTL_MS, probe.measure, time.now);

    const both = Promise.all([cache.size("/a"), cache.refresh("/a")]);
    await settle();
    await probe.release();

    expect(await both).toEqual([100, 100]);
    expect(probe.calls).toEqual(["/a"]);
  });

  it("ignores a cached value when asked to refresh", async () => {
    const time = clock();
    const probe = recorder([100, 400]);
    const cache = new DiskUsageCache(4, DISK_USAGE_CACHE_TTL_MS, probe.measure, time.now);

    await cache.size("/a");

    expect(await cache.refresh("/a")).toBe(400);
    expect(probe.calls).toEqual(["/a", "/a"]);
  });

  it("leaves a refreshed value where the status view will find it", async () => {
    const time = clock();
    const probe = recorder([400]);
    const cache = new DiskUsageCache(4, DISK_USAGE_CACHE_TTL_MS, probe.measure, time.now);

    await cache.refresh("/a");

    expect(await cache.size("/a")).toBe(400);
    expect(probe.calls).toEqual(["/a"]);
  });

  it("never remembers a failed walk", async () => {
    const time = clock();
    const calls: string[] = [];
    let attempt = 0;
    const cache = new DiskUsageCache(
      4,
      DISK_USAGE_CACHE_TTL_MS,
      (dirPath) => {
        calls.push(dirPath);
        attempt += 1;
        return attempt === 1 ? Promise.reject(new Error("du: cannot read directory")) : Promise.resolve(700);
      },
      time.now,
    );

    await expect(cache.size("/a")).rejects.toThrow("du: cannot read directory");

    expect(await cache.size("/a")).toBe(700);
    expect(calls).toEqual(["/a", "/a"]);
  });

  it("gives two status view opens one walk", async () => {
    const time = clock();
    const probe = gatedRecorder();
    const cache = new DiskUsageCache(4, DISK_USAGE_CACHE_TTL_MS, probe.measure, time.now);

    const both = Promise.all([cache.size("/a"), cache.size("/a")]);
    await settle();
    await probe.release();

    expect(await both).toEqual([100, 100]);
    expect(probe.calls).toEqual(["/a"]);
  });

  it("serves a status view opened mid-refresh from the walk the refresh started", async () => {
    const time = clock();
    const probe = gatedRecorder();
    const cache = new DiskUsageCache(4, DISK_USAGE_CACHE_TTL_MS, probe.measure, time.now);

    const header = cache.refresh("/a");
    await settle();
    const view = cache.size("/a");
    await settle();

    expect(probe.calls).toEqual(["/a"]);
    await probe.release();
    expect(await Promise.all([header, view])).toEqual([100, 100]);
  });

  it("never lets a refresh inherit a walk that had already begun reading", async () => {
    const time = clock();
    const probe = gatedSizes([900, 400]);
    const cache = new DiskUsageCache(4, DISK_USAGE_CACHE_TTL_MS, probe.measure, time.now);

    const view = cache.size("/a");
    await settle();
    expect(probe.calls).toEqual(["/a"]);

    const header = cache.refresh("/a");
    await settle();
    expect(probe.calls).toEqual(["/a", "/a"]);

    await probe.release(1);
    await probe.release(0);

    expect(await header).toBe(400);
    expect(await view).toBe(900);
    expect(await cache.size("/a")).toBe(400);
    expect(probe.calls).toEqual(["/a", "/a"]);
  });

  it("re-walks a directory whose size it was told to forget", async () => {
    const time = clock();
    const probe = recorder([100, 250]);
    const cache = new DiskUsageCache(4, DISK_USAGE_CACHE_TTL_MS, probe.measure, time.now);

    expect(await cache.size("/a")).toBe(100);
    cache.invalidate("/a");

    expect(await cache.size("/a")).toBe(250);
    expect(probe.calls).toEqual(["/a", "/a"]);
  });

  it("keeps a walk that began before an invalidation from recording its figure", async () => {
    const time = clock();
    const probe = gatedSizes([900, 400]);
    const cache = new DiskUsageCache(4, DISK_USAGE_CACHE_TTL_MS, probe.measure, time.now);

    const before = cache.size("/a");
    await settle();
    cache.invalidate("/a");

    const after = cache.size("/a");
    await settle();
    await probe.release(1);
    await probe.release(0);

    expect(await before).toBe(900);
    expect(await after).toBe(400);
    expect(await cache.size("/a")).toBe(400);
    expect(probe.calls).toEqual(["/a", "/a"]);
  });

  it("holds the walks to the parallelism it was given", async () => {
    const time = clock();
    const probe = gatedRecorder();
    const cache = new DiskUsageCache(2, DISK_USAGE_CACHE_TTL_MS, probe.measure, time.now);

    const all = Promise.all(["/a", "/b", "/c", "/d", "/e"].map((dirPath) => cache.size(dirPath)));
    await settle();
    expect(probe.inFlight()).toBe(2);

    for (let round = 0; round < 5; round++) await probe.release();
    await all;

    expect(probe.peak()).toBe(2);
    expect(probe.calls).toEqual(["/a", "/b", "/c", "/d", "/e"]);
  });
});
