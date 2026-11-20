import * as path from "path";

import type { SimpleGit } from "simple-git";

export const GIT_CLIENT_CACHE_LIMIT = 512;

const KEY_SEPARATOR = "\u0000";

export class GitClientCache {
  private readonly entries = new Map<string, { dirPath: string; client: SimpleGit }>();

  constructor(private readonly limit: number = GIT_CLIENT_CACHE_LIMIT) {}

  get(dirPath: string, variant: string, build: () => SimpleGit): SimpleGit {
    const resolved = path.resolve(dirPath);
    const key = `${resolved}${KEY_SEPARATOR}${variant}`;
    const cached = this.entries.get(key);
    if (cached !== undefined) {
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

  forget(dirPath: string): void {
    const resolved = path.resolve(dirPath);
    for (const [key, entry] of this.entries) {
      if (entry.dirPath === resolved) this.entries.delete(key);
    }
  }

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
