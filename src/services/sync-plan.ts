import type { RepoOperationNotStarted, RepositoryMode, SyncOutcomeScope } from "../types";

// What `sync --dry-run` reports: the steps a sync would take for one
// repository, computed by the same assessments the sync runs before it
// mutates anything, and never executed. The reason codes are the ones the
// sync records in its outcome for the same decision, so a plan and the
// outcome of the sync that follows it can be read side by side.
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
      // new_branch: origin has a branch with no worktree yet.
      // missing_directory: registered, but its directory is gone; rebuilt.
      // default_branch: the default branch's worktree, which every fetch runs in.
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
      // Diverged with local changes: the worktree is preserved (trash, or
      // `.diverged/` with trash off) and recreated from origin/<branch>.
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
      // Why the worktree is no longer wanted.
      reason: "deleted_on_remote" | "excluded_by_filters" | "reserved_by_trash";
      // Why removing it is safe, as the status check that authorizes it saw it.
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
  // Whether computing the plan fetched from origin (updating remote-tracking
  // refs only). False when there was no local repository to fetch into.
  fetched: boolean;
  // Repository-level observations that are not steps: work a sync does
  // before planning (unshallowing, narrowing a refspec), and places where
  // the plan can differ from what the sync will do.
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
