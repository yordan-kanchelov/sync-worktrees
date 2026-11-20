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

  setMaxParallel(maxParallel: number): void {
    this.limit.concurrency = Math.max(1, maxParallel);
  }

  async size(dirPath: string): Promise<number> {
    const cached = this.measured.get(dirPath);
    if (cached !== undefined && this.now() - cached.measuredAt < this.ttlMs) {
      return cached.bytes;
    }
    return this.walk(dirPath, this.inFlight);
  }

  async refresh(dirPath: string): Promise<number> {
    return this.walk(dirPath, this.queued);
  }

  invalidate(dirPath: string): void {
    this.measured.delete(dirPath);
    this.inFlight.delete(dirPath);
    this.queued.delete(dirPath);
  }

  private async walk(dirPath: string, joinable: Map<string, Promise<number>>): Promise<number> {
    const running = joinable.get(dirPath);
    if (running !== undefined) return running;

    const started: Promise<number> = this.limit(() => {
      this.queued.delete(dirPath);
      return this.measure(dirPath);
    })
      .then((bytes) => {
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
