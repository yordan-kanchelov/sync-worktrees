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

/** Answers at once; records which directories were walked, in order. */
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

/** Answers only when released, so overlap can be observed from inside. */
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

/** One gate per walk, each answering with its own figure, so a stale walk is
 *  distinguishable from the walk that overtook it. */
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
    // Against the shipped TTL, not the symbol the class is built from: a test
    // that advances by DISK_USAGE_CACHE_TTL_MS re-walks whatever that constant
    // is, so it cannot tell a minute from forever. The changeset promises the
    // view's repeat opens are served from cache "for up to a minute"; this is
    // that minute.
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

    // Opening the view mid-cycle costs no extra `du`: what the header is
    // already walking is at worst as stale as the moment the view was opened.
    expect(probe.calls).toEqual(["/a"]);
    await probe.release();
    expect(await Promise.all([header, view])).toEqual([100, 100]);
  });

  it("never lets a refresh inherit a walk that had already begun reading", async () => {
    const time = clock();
    const probe = gatedSizes([900, 400]);
    const cache = new DiskUsageCache(4, DISK_USAGE_CACHE_TTL_MS, probe.measure, time.now);

    // The status view opens and its walk reaches the filesystem.
    const view = cache.size("/a");
    await settle();
    expect(probe.calls).toEqual(["/a"]);

    // The directory shrinks, and only then is the header's refresh asked for.
    // Joining here is what made the header report a pre-mutation size and then
    // stamp it fresh for the whole TTL -- measured 5/5 on a 93,003-path tree,
    // overstating by 64 MB after a shrink that had already returned.
    const header = cache.refresh("/a");
    await settle();
    expect(probe.calls).toEqual(["/a", "/a"]);

    // The stale walk finishes last, so it must not be the one that is recorded.
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
