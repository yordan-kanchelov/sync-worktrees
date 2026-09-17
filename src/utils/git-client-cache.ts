import * as path from "path";

import type { SimpleGit } from "simple-git";

/**
 * How many clients one cache keeps. This is a backstop, not the mechanism:
 * every path that stops being a worktree is dropped explicitly (see
 * GitService's forgetCachedClients), and the bound is only what keeps a path
 * nobody remembered to drop — a trash payload probed once, a directory some
 * future caller moves without saying so — from being retained for the life of
 * a daemon. The bound counts entries, not worktrees: a path can hold up to
 * three variants in GitService and one in the status service, so 512 entries is
 * roughly 170 to 256 live worktrees. Past that, clients are rebuilt on demand,
 * which costs an object and one stat of the working directory, never a git
 * process.
 */
export const GIT_CLIENT_CACHE_LIMIT = 512;

/**
 * Joins the two halves of a cache key. NUL cannot appear in a path on any
 * supported platform, so no directory name can be read as a directory plus a
 * variant.
 */
const KEY_SEPARATOR = "\u0000";

/**
 * The simple-git clients one service caches, keyed by resolved directory plus
 * the caller's variant tag (the LFS env and timeout combination it needs).
 * Clients are cached for their spawn-option reuse, but the directory a worktree
 * client points at dies with the worktree, so the cache must also be able to
 * forget a path — every variant of it at once, which is why the path is a field
 * of the entry rather than half of an opaque key.
 *
 * Forgetting a path only drops map entries. A client handed out earlier keeps
 * working: the caller holds the reference and simple-git's scheduler lives on
 * the instance, so neither forget() nor the size bound can disturb an operation
 * already in flight.
 */
export class GitClientCache {
  private readonly entries = new Map<string, { dirPath: string; client: SimpleGit }>();

  constructor(private readonly limit: number = GIT_CLIENT_CACHE_LIMIT) {}

  /** The client cached for (dirPath, variant), built by `build` on a miss. */
  get(dirPath: string, variant: string, build: () => SimpleGit): SimpleGit {
    const resolved = path.resolve(dirPath);
    const key = `${resolved}${KEY_SEPARATOR}${variant}`;
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      // A Map iterates in insertion order, so re-inserting a hit makes it the
      // newest entry and the bound below drops the least recently used one.
      // The clients a phase keeps reaching for — the bare repository's, the
      // anchor worktree's — are therefore the last ones it can lose, which
      // matters beyond memory: a shared client is also what caps how many git
      // processes that phase runs at once (see SIMPLE_GIT_CLIENT_CONCURRENCY).
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.client;
    }

    const client = build();
    this.entries.set(key, { dirPath: resolved, client });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    return client;
  }

  /** Drops every variant cached for a directory that is gone, or about to be. */
  forget(dirPath: string): void {
    const resolved = path.resolve(dirPath);
    for (const [key, entry] of this.entries) {
      if (entry.dirPath === resolved) this.entries.delete(key);
    }
  }

  /** How many clients are cached for one directory, across every variant. */
  countFor(dirPath: string): number {
    const resolved = path.resolve(dirPath);
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.dirPath === resolved) count++;
    }
    return count;
  }

  get size(): number {
    return this.entries.size;
  }
}
