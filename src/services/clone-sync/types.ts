import type { BranchCreatedActionsService } from "../branch-created-actions.service";
import type { GitService } from "../git.service";
import type { Logger } from "../logger.service";
import type { SyncOutcomeAccumulator } from "../sync-outcome";
import type { CloneGitClients } from "./git-clients";
import type { Config } from "../../types";
import type { GitProgressEvent } from "../../utils/git-progress";

export type CloneSkipReason =
  | { kind: "branch_mismatch"; phase: "init" | "sync"; currentBranch: string; expectedBranch: string }
  | { kind: "head_unreadable"; phase: "init" | "sync"; error: string }
  | { kind: "dirty_tree" }
  | { kind: "diverged"; branch: string }
  | { kind: "ahead_unpushed"; branch: string }
  | { kind: "missing_remote_ref"; branch: string; source: "fetch_error" | "post_fetch_verify" }
  | { kind: "indeterminate_shallow"; branch: string; deepenedTo: number | null }
  | { kind: "origin_mismatch"; actual: string; expected: string };

export type CloneSkipListener = (reason: CloneSkipReason) => void;

export interface CloneSkipDescriptor {
  skip: CloneSkipReason;
  warnMessage: string;
  progressDetail: string;
}

export interface PendingCloneSkip {
  skip: CloneSkipReason;
  logMessage: string;
  progressMessage: string;
  logLevel: "warn" | "info";
}

export interface CloneSyncContext {
  readonly config: Config;
  readonly gitService: GitService;
  readonly logger: Logger;
  readonly branchCreatedActions: BranchCreatedActionsService;
  readonly clients: CloneGitClients;
  readonly repoName: string;
  readonly trackedBranch: string | undefined;
  readonly outcome: SyncOutcomeAccumulator | undefined;
  emitProgress(event: GitProgressEvent): void;
  recordSkip(reason: CloneSkipReason, logMessage: string, progressMessage?: string, logLevel?: "warn" | "info"): void;
}
