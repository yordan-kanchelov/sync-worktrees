import type { RepoOperationNotStarted, RepositoryMode, SyncOutcomeScope } from "../types";

export type SyncDryRunStep =
  | {
      kind: "clone";
      path: string;
      branch?: string;
      message: string;
    }
  | {
      kind: "create";
      branch: string;
      path: string;
      reason: "new_branch" | "missing_directory" | "default_branch";
    }
  | {
      kind: "update";
      branch: string;
      path: string;
      reason: "fast_forward" | "reset_identical_tree" | "reset_no_local_changes" | "sparse_checkout";
      message?: string;
    }
  | {
      kind: "replace";
      branch: string;
      path: string;
      reason: "diverged_local_changes";
      preservedIn: "trash" | "diverged_dir";
      message: string;
    }
  | {
      kind: "remove";
      branch: string;
      path: string;
      reason: "deleted_on_remote" | "excluded_by_filters" | "reserved_by_trash";
      basis: "fully_pushed_remote_deleted" | "clean_and_pushed" | "directory_missing";
      disposal: "trash" | "delete";
      message: string;
    }
  | {
      kind: "skip";
      scope: SyncOutcomeScope;
      reason: string;
      branch?: string;
      path?: string;
      message?: string;
    }
  | {
      kind: "noop";
      scope: SyncOutcomeScope;
      reason: string;
      branch?: string;
      path?: string;
      message?: string;
    };

export type SyncDryRunStepKind = SyncDryRunStep["kind"];

export type SyncDryRunCounts = Record<SyncDryRunStepKind, number>;

export interface SyncDryRunPlan {
  repoName?: string;
  mode: RepositoryMode;
  fetched: boolean;
  notes: string[];
  steps: SyncDryRunStep[];
  counts: SyncDryRunCounts;
}

export type SyncPlanResult = { started: true; plan: SyncDryRunPlan } | RepoOperationNotStarted;

export function emptyDryRunCounts(): SyncDryRunCounts {
  return { clone: 0, create: 0, update: 0, replace: 0, remove: 0, skip: 0, noop: 0 };
}

export class SyncDryRunPlanBuilder {
  private readonly steps: SyncDryRunStep[] = [];
  private readonly notes: string[] = [];
  private fetched = false;

  constructor(private readonly options: { mode: RepositoryMode; repoName?: string }) {}

  add(step: SyncDryRunStep): void {
    this.steps.push(step);
  }

  note(message: string): void {
    this.notes.push(message);
  }

  markFetched(): void {
    this.fetched = true;
  }

  build(): SyncDryRunPlan {
    const counts = emptyDryRunCounts();
    for (const step of this.steps) counts[step.kind]++;
    return {
      ...(this.options.repoName !== undefined && { repoName: this.options.repoName }),
      mode: this.options.mode,
      fetched: this.fetched,
      notes: [...this.notes],
      steps: [...this.steps],
      counts,
    };
  }
}
