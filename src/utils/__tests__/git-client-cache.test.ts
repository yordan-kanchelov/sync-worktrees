import * as path from "path";

import { describe, expect, it } from "vitest";

import { GitClientCache } from "../git-client-cache";

import type { SimpleGit } from "simple-git";

// The cache exists for spawn-option reuse, but a worktree's directory outlives
// nothing: it is removed, trashed or quarantined while the process keeps
// running. These tests pin the two properties that keeps costing memory —
// a forgotten path leaves nothing behind, and the cache is bounded even for a
// path nobody forgets.
describe("GitClientCache", () => {
  const client = (name: string): SimpleGit => ({ name }) as unknown as SimpleGit;

  it("hands back the same client for one (path, variant) and builds one per variant", () => {
    const cache = new GitClientCache();
    let built = 0;

    const first = cache.get("/repo/feature", "local", () => client(`c${++built}`));
    const again = cache.get("/repo/feature", "local", () => client(`c${++built}`));
    const other = cache.get("/repo/feature", "network", () => client(`c${++built}`));

    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(built).toBe(2);
    expect(cache.countFor("/repo/feature")).toBe(2);
  });

  it("keys by the resolved path, so the same directory named two ways is one entry", () => {
    const cache = new GitClientCache();
    let built = 0;

    const direct = cache.get("/repo/feature", "local", () => client(`c${++built}`));
    const roundabout = cache.get("/repo/other/../feature", "local", () => client(`c${++built}`));

    expect(roundabout).toBe(direct);
    expect(cache.size).toBe(1);
  });

  it("forgets every variant of a path and leaves the other paths cached", () => {
    const cache = new GitClientCache();
    cache.get("/repo/feature", "local", () => client("a"));
    cache.get("/repo/feature", "network", () => client("b"));
    cache.get("/repo/main", "local", () => client("c"));

    cache.forget("/repo/feature");

    expect(cache.countFor("/repo/feature")).toBe(0);
    expect(cache.countFor("/repo/main")).toBe(1);
    expect(cache.size).toBe(1);
  });

  it("forgets a path given in a different but equivalent form", () => {
    const cache = new GitClientCache();
    cache.get("/repo/feature", "local", () => client("a"));

    cache.forget(path.join("/repo", "other", "..", "feature"));

    expect(cache.size).toBe(0);
  });

  it("leaves a client already handed out usable after its entry is forgotten", () => {
    const cache = new GitClientCache();
    const handedOut = cache.get("/repo/feature", "local", () => client("a"));

    cache.forget("/repo/feature");

    // Nothing about the instance changes — only the map entry is gone, so an
    // operation still running on it cannot be interrupted by the eviction.
    expect(handedOut).toEqual({ name: "a" });
    expect(cache.get("/repo/feature", "local", () => client("b"))).not.toBe(handedOut);
  });

  it("never grows past its limit, dropping the least recently used entry", () => {
    const cache = new GitClientCache(2);
    const first = cache.get("/repo/a", "local", () => client("a"));
    cache.get("/repo/b", "local", () => client("b"));

    // Using /repo/a again makes /repo/b the coldest entry, so it is the one
    // that goes when /repo/c arrives.
    expect(cache.get("/repo/a", "local", () => client("a2"))).toBe(first);
    cache.get("/repo/c", "local", () => client("c"));

    expect(cache.size).toBe(2);
    expect(cache.countFor("/repo/a")).toBe(1);
    expect(cache.countFor("/repo/b")).toBe(0);
    expect(cache.countFor("/repo/c")).toBe(1);
  });
});
