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

/**
 * Build a progress callback for simple-git's `progress` option that:
 *   - filters to clone/fetch/pull events only,
 *   - emits at most one log per (method,stage) bucket of PROGRESS_BUCKET_PERCENT,
 *   - always emits the 100% completion line,
 *   - detects stage restarts (bucket regression on the same cached SimpleGit
 *     instance, e.g. a second fetch) and resets the bucket so the new run
 *     logs from scratch.
 *
 * State (the bucket map) is closure-local — pass one handler per SimpleGit
 * client. The contract is user-visible log output, so prefer this shared
 * factory over copies in each caller.
 */
export function makeGitProgressHandler(
  logger: Logger,
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
    logger.info(`  ↳ ${message}`);
    emitProgress?.({
      phase: event.method,
      message,
      progress: event.progress,
      processed: event.processed,
      total: event.total,
    });
  };
}
