import { GIT_CONSTANTS } from "../constants";

import type { Logger } from "../services/logger.service";
import type { SimpleGitProgressEvent } from "simple-git";

export interface GitProgressEvent {
  phase: string;
  message: string;
  progress?: number;
  processed?: number;
  total?: number;
}

export type GitProgressEmitter = (event: GitProgressEvent) => void;

export function makeGitProgressHandler(
  getLogger: () => Logger,
  emitProgress?: GitProgressEmitter,
): (event: SimpleGitProgressEvent) => void {
  const lastBucket = new Map<string, number>();
  return (event: SimpleGitProgressEvent): void => {
    if (event.method !== "fetch" && event.method !== "clone" && event.method !== "pull") return;
    const key = `${event.method}:${event.stage}`;
    const bucket = Math.floor(event.progress / GIT_CONSTANTS.PROGRESS_BUCKET_PERCENT);
    let last = lastBucket.get(key) ?? -1;
    if (bucket < last) last = -1;
    if (bucket <= last && event.progress < 100) return;
    lastBucket.set(key, bucket);
    const total = event.total > 0 ? `${event.processed}/${event.total}` : `${event.processed}`;
    const message = `${event.method} ${event.stage}: ${event.progress}% (${total})`;
    getLogger().debug(`  ↳ ${message}`);
    emitProgress?.({
      phase: event.method,
      message,
      progress: event.progress,
      processed: event.processed,
      total: event.total,
    });
  };
}
