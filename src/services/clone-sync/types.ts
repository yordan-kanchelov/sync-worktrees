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

// A skip the caller has not recorded yet: what it is, the log line, and the
// shorter wording the progress stream shows after "Skipping '<repo>': ".
export interface CloneSkipDescriptor {
  skip: CloneSkipReason;
  warnMessage: string;
  progressDetail: string;
}

// A skip decided but not recorded yet, with the exact log and progress lines
// the tick records it with. Lets a dry run report the same decision.
export interface PendingCloneSkip {
  skip: CloneSkipReason;
  logMessage: string;
  progressMessage: string;
  logLevel: "warn" | "info";
}

// What the clone-mode modules share with the CloneSyncService that owns them.
// Every member reads through to the service at the moment it is used — the
// logger can be swapped by updateLogger, the outcome accumulator by each
// initialize/runSyncAttempt call — so a module never holds a stale copy.
export interface CloneSyncContext {
  readonly config: Config;
  readonly gitService: GitService;
  readonly logger: Logger;
  readonly branchCreatedActions: BranchCreatedActionsService;
  readonly clients: CloneGitClients;
  // Display name only (log lines and progress messages), with any credentials
  // in a URL fallback stripped.
  readonly repoName: string;
  // The branch the remote refspec maintains: the resolved one once known,
  // otherwise the configured one.
  readonly trackedBranch: string | undefined;
  readonly outcome: SyncOutcomeAccumulator | undefined;
  emitProgress(event: GitProgressEvent): void;
  recordSkip(reason: CloneSkipReason, logMessage: string, progressMessage?: string, logLevel?: "warn" | "info"): void;
}
