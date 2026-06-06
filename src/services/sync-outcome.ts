import { formatCloneSkipReason } from "../utils/clone-skip-format";

import type { CloneSkipReason } from "./clone-sync.service";
import type { SyncOutcome, SyncOutcomeAction, SyncOutcomeCounts, SyncOutcomeMode, SyncOutcomeScope } from "../types";

const EMPTY_COUNTS: SyncOutcomeCounts = {
  created: 0,
  removed: 0,
  updated: 0,
  skipped: 0,
  preserved: 0,
  failed: 0,
  noop: 0,
};

function cloneCounts(counts: SyncOutcomeCounts): SyncOutcomeCounts {
  return { ...counts };
}

function cloneAction(action: SyncOutcomeAction): SyncOutcomeAction {
  return { ...action } as SyncOutcomeAction;
}

function countKeyFor(action: SyncOutcomeAction): keyof SyncOutcomeCounts {
  switch (action.kind) {
    case "created":
      return "created";
    case "removed":
      return "removed";
    case "updated":
      return "updated";
    case "skipped":
      return "skipped";
    case "preserved-diverged":
      return "preserved";
    case "failed":
      return "failed";
    case "noop":
      return "noop";
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

export class SyncOutcomeAccumulator {
  private counts: SyncOutcomeCounts = cloneCounts(EMPTY_COUNTS);
  private actions: SyncOutcomeAction[] = [];

  constructor(
    private readonly options: {
      mode: SyncOutcomeMode;
      repoName?: string;
    },
  ) {}

  add(action: SyncOutcomeAction): void {
    this.actions.push(action);
    this.counts[countKeyFor(action)]++;
  }

  recordCreated(branch: string, path: string): void {
    this.add({ kind: "created", branch, path });
  }

  recordRemoved(branch: string, path: string, warning?: string): void {
    this.add({ kind: "removed", branch, path, ...(warning !== undefined && { warning }) });
  }

  recordUpdated(branch: string, path: string, reason?: string): void {
    this.add({ kind: "updated", branch, path, reason });
  }

  recordNoop(
    scope: SyncOutcomeScope,
    reason: string,
    details: { branch?: string; path?: string; message?: string },
  ): void {
    this.add({ kind: "noop", scope, reason, ...details });
  }

  recordSkipped(
    scope: SyncOutcomeScope,
    reason: string,
    details: { branch?: string; path?: string; message?: string },
  ): void {
    this.add({ kind: "skipped", scope, reason, ...details });
  }

  recordPreservedDiverged(branch: string, path: string, preservedPath: string): void {
    this.add({ kind: "preserved-diverged", branch, path, preservedPath });
  }

  recordFailed(
    scope: SyncOutcomeScope,
    error: string,
    details: { reason?: string; branch?: string; path?: string } = {},
  ): void {
    this.add({ kind: "failed", scope, error, ...details });
  }

  getCounts(): SyncOutcomeCounts {
    return cloneCounts(this.counts);
  }

  snapshot(): { counts: SyncOutcomeCounts; actions: SyncOutcomeAction[] } {
    return {
      counts: cloneCounts(this.counts),
      actions: this.actions.map(cloneAction),
    };
  }

  restore(snapshot: { counts: SyncOutcomeCounts; actions: SyncOutcomeAction[] }): void {
    this.counts = cloneCounts(snapshot.counts);
    this.actions = snapshot.actions.map(cloneAction);
  }

  toOutcome(durationMs?: number): SyncOutcome {
    return {
      repoName: this.options.repoName,
      mode: this.options.mode,
      started: true,
      counts: cloneCounts(this.counts),
      actions: this.actions.map(cloneAction),
      durationMs,
    };
  }
}

export function createEmptySyncOutcome(mode: SyncOutcomeMode, repoName?: string, durationMs?: number): SyncOutcome {
  return {
    repoName,
    mode,
    started: true,
    counts: cloneCounts(EMPTY_COUNTS),
    actions: [],
    durationMs,
  };
}

export function cloneSkipToOutcomeAction(
  reason: CloneSkipReason,
  details: { branch?: string; path?: string } = {},
): SyncOutcomeAction {
  const message = formatCloneSkipReason(reason);
  const branch =
    "branch" in reason ? reason.branch : reason.kind === "branch_mismatch" ? reason.expectedBranch : details.branch;

  return {
    kind: "skipped",
    scope: "repo",
    reason: `clone_${reason.kind}`,
    branch,
    path: details.path,
    message,
  };
}
