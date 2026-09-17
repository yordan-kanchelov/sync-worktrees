import type { LimitFunction } from "p-limit";
import pLimit from "p-limit";

import { calculateDirectorySize } from "./disk-space";

export const DISK_USAGE_CACHE_TTL_MS = 60_000;

interface Measurement {
  bytes: number;
  measuredAt: number;
}

export class DiskUsageCache {
  private readonly measured = new Map<string, Measurement>();
  private readonly inFlight = new Map<string, Promise<number>>();
  private readonly queued = new Map<string, Promise<number>>();
  private readonly limit: LimitFunction;

  constructor(
    maxParallel = 1,
    private readonly ttlMs = DISK_USAGE_CACHE_TTL_MS,
    private readonly measure: (dirPath: string) => Promise<number> = calculateDirectorySize,
    private readonly now: () => number = Date.now,
  ) {
    this.limit = pLimit(Math.max(1, maxParallel));
  }

  async size(dirPath: string): Promise<number> {
    // The status view's reader. It walked the same bare repository and worktree
    // directory again on every single open, duplicating the walk the header had
    // just done and paying twice for two opens a second apart.
    //
    // Deliberately not keyed by mtime: a directory's mtime does not move when a
    // file below it changes, so an mtime key would hand back a stale number
    // while claiming it is current. Measured here -- a write four levels down a
    // 95,657-path tree changed its `du -sb` total and left the top directory's
    // mtime untouched.
    //
    // Any walk in flight is the answer this caller wants, whoever started it:
    // it is at worst as stale as the moment the view was opened.
    const cached = this.measured.get(dirPath);
    if (cached !== undefined && this.now() - cached.measuredAt < this.ttlMs) {
      return cached.bytes;
    }
    return this.walk(dirPath, this.inFlight);
  }

  async refresh(dirPath: string): Promise<number> {
    // The header's reader, and the reason the TTL costs the user nothing: the
    // total beside "Disk:" is rebuilt from walks that ignore the cache, so it
    // is exactly as fresh as the sync cycle that asked for it, and a force
    // clean's freed space shows up at once -- in the view too, since the same
    // walk refills the cache the view reads.
    //
    // It joins only a walk that has not begun reading the filesystem, which is
    // the same rule as "a walk that began after this refresh was asked for":
    // time runs forwards, so a walk already reading began at or before now, and
    // one still queued behind the limiter can only begin after. Without that
    // rule a refresh issued strictly after a force clean joined the walk a
    // status view had started before it, returned that walk's pre-mutation
    // figure, and stamped it fresh for the whole TTL -- measured 5/5 on a
    // 93,003-path tree, overstating by 64 MB. `du` exiting 1 when a path
    // vanishes mid-walk does not cover this: repacking shrinks entries it has
    // already counted rather than removing them.
    return this.walk(dirPath, this.queued);
  }

  invalidate(dirPath: string): void {
    // For the operations that shrink a directory themselves. Without it a
    // `.diverged/` directory deleted from the status view left the repository's
    // total as it was for a whole TTL, across closing and reopening the modal
    // -- a regression against the walk-every-open behaviour this cache
    // replaced. Dropping the in-flight entries as well stops a walk that began
    // before the deletion from recording its result afterwards.
    this.measured.delete(dirPath);
    this.inFlight.delete(dirPath);
    this.queued.delete(dirPath);
  }

  private async walk(dirPath: string, joinable: Map<string, Promise<number>>): Promise<number> {
    // `inFlight` holds every running walk, `queued` only those the limiter has
    // not dispatched yet, so which map a caller may join is the whole of the
    // freshness rule. A rejected walk is never recorded, so the next caller
    // retries instead of inheriting the failure for a whole TTL.
    const running = joinable.get(dirPath);
    if (running !== undefined) return running;

    const started: Promise<number> = this.limit(() => {
      this.queued.delete(dirPath);
      return this.measure(dirPath);
    })
      .then((bytes) => {
        // Only the newest walk for this directory records: an older one still
        // running when a refresh overtook it, or when the directory was
        // invalidated, would otherwise write a figure that predates both.
        if (this.inFlight.get(dirPath) === started) {
          this.measured.set(dirPath, { bytes, measuredAt: this.now() });
        }
        return bytes;
      })
      .finally(() => {
        if (this.inFlight.get(dirPath) === started) this.inFlight.delete(dirPath);
        if (this.queued.get(dirPath) === started) this.queued.delete(dirPath);
      });

    this.inFlight.set(dirPath, started);
    this.queued.set(dirPath, started);
    return started;
  }
}
