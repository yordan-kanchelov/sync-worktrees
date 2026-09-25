import * as fs from "fs/promises";
import * as path from "path";

import pLimit from "p-limit";

import { DEFAULT_CONFIG, ENV_CONSTANTS, GIT_CONSTANTS, GIT_OPERATIONS, PATH_CONSTANTS } from "../constants";
import { GitOperationError, WorktreeNotCleanError } from "../errors";
import { probePathExists } from "../utils/file-exists";
import { createGitClient } from "../utils/git-client";
import { GitClientCache } from "../utils/git-client-cache";
import { getErrorMessage } from "../utils/errors";

import { Logger } from "./logger.service";

import type { LastKnownRemoteTip } from "../types/sync-metadata";
import type { LimitFunction } from "p-limit";
import type { SimpleGit } from "simple-git";

export interface WorktreeStatusDetails {
  modifiedFiles: number;
  deletedFiles: number;
  renamedFiles: number;
  createdFiles: number;
  conflictedFiles: number;
  untrackedFiles: number;
  unpushedCommitCount?: number;
  stashCount?: number;
  operationType?: string;
  modifiedSubmodules?: string[];
  modifiedFilesList?: string[];
  deletedFilesList?: string[];
  renamedFilesList?: Array<{ from: string; to: string }>;
  createdFilesList?: string[];
  conflictedFilesList?: string[];
  untrackedFilesList?: string[];
}

export interface WorktreeStatusResult {
  isClean: boolean;
  hasUnpushedCommits: boolean;
  hasStashedChanges: boolean;
  hasOperationInProgress: boolean;
  hasModifiedSubmodules: boolean;
  upstreamGone: boolean;
  // True when commits look unpushed only because the upstream ref was deleted
  // (squash-merge + branch deletion): metadata recorded the upstream tip while
  // it existed, that ref is now gone, and HEAD is an ancestor of (or equal to)
  // the recorded tip — so every local commit was on the remote at some point.
  fullyPushedUpstreamDeleted: boolean;
  canRemove: boolean;
  reasons: string[];
  // Commits HEAD has that @{upstream} lacks and the other way round. null when
  // there is no upstream ref to compare against — see getFullWorktreeStatus.
  divergence: { ahead: number; behind: number } | null;
  details?: WorktreeStatusDetails;
}

const OPERATION_FILES: ReadonlyArray<{ file: string; type: string }> = [
  { file: GIT_OPERATIONS.MERGE_HEAD, type: "merge" },
  { file: GIT_OPERATIONS.CHERRY_PICK_HEAD, type: "cherry-pick" },
  { file: GIT_OPERATIONS.REVERT_HEAD, type: "revert" },
  { file: GIT_OPERATIONS.BISECT_LOG, type: "bisect" },
  { file: GIT_OPERATIONS.REBASE_MERGE, type: "rebase" },
  { file: GIT_OPERATIONS.REBASE_APPLY, type: "rebase (apply)" },
];

// `git submodule status` prints one line per submodule: a single status
// character in column 0, the recorded object id, the path, and — only for an
// initialized submodule — a " (<describe>)" suffix.
//
//   " " in sync   "-" not initialized   "+" commit differs   "U" merge conflicts
//
// Only "+" and "U" mean the worktree holds submodule state that could be lost.
// "-" is the state every tool-created worktree starts in, because `git worktree
// add` never initializes submodules; counting it as modified made every
// worktree of a repo with submodules permanently un-prunable.
//
// A submodule path can contain spaces, so the path is everything after the
// object id minus the describe suffix — not the first \S+ run (which used to
// hand callers the object id itself).
const SUBMODULE_STATUS_LINE = /^(.)(\S+)[ \t]+(.+)$/;
const SUBMODULE_DESCRIBE_SUFFIX = /[ \t]+\([^()]*\)$/;

function parseModifiedSubmodulePath(line: string): string | null {
  const match = SUBMODULE_STATUS_LINE.exec(line);
  if (!match) return null;
  const [, prefix, , rest] = match;
  if (prefix !== GIT_CONSTANTS.SUBMODULE_STATUS_OUT_OF_SYNC && prefix !== GIT_CONSTANTS.SUBMODULE_STATUS_CONFLICTED) {
    return null;
  }
  const submodulePath = rest.replace(SUBMODULE_DESCRIBE_SUFFIX, "").trim();
  return submodulePath || null;
}

function collectModifiedSubmodules(submoduleStatus: string): string[] {
  const modified: string[] = [];
  for (const line of submoduleStatus.split("\n")) {
    if (!line.trim()) continue;
    const submodulePath = parseModifiedSubmodulePath(line);
    if (submodulePath) modified.push(submodulePath);
  }
  return modified;
}

// refs/stash lives in the common git dir, so `git stash list` in any worktree
// lists the stashes of every worktree of the repository. Each entry is
// attributed back to the worktree it was made in, or one stash anywhere would
// block every prune and diverged replace and label every worktree dirty.
//
// `git stash` writes the reflog subject "WIP on <branch>: ..." or
// "On <branch>: <message>", with "(no branch)" for a detached HEAD. A refname
// can contain neither ':' nor whitespace, so the name up to the first ':' is
// exact even when the user's own message contains colons.
const STASH_LIST_FORMAT = { hash: "%H", parents: "%P", subject: "%gs" } as const;
const STASH_SUBJECT_BRANCH = /^(?:WIP on|On) ([^\s:]+):/;

interface StashEntry {
  hash: string;
  parents: string;
  subject: string;
}

/** The branch a stash was made on, or null when its subject does not name one. */
export function stashSubjectBranch(subject: string): string | null {
  const match = STASH_SUBJECT_BRANCH.exec(subject);
  return match ? match[1] : null;
}

type StashListing = Awaited<ReturnType<SimpleGit["stashList"]>>;

interface WorktreeSnapshot {
  exists: boolean;
  status: Awaited<ReturnType<SimpleGit["status"]>> | null;
  currentBranch: string | null;
  detached: boolean;
  remoteBranches: string[];
  upstream: string | null;
  unpushedAnyRemoteCount: number | null;
  sinceSyncCount: number | null;
  sinceSyncChecked: boolean;
  // null = no recorded tip to check against; false also covers probe errors
  // (e.g. the recorded oid was gc'd away), which must read as "not proven".
  headPushedToRecordedTip: boolean | null;
  stashTotal: number | null;
  submoduleStatus: string | null;
  operationFile: string | null;
  operationProbeUnknown: boolean;
  gitDir: string | null;
  untrackedNotIgnored: string[];
}

export interface WorktreeStatusServiceConfig {
  skipLfs?: boolean;
  /**
   * Ceiling on the git processes this service has running at once, across every
   * worktree it is asked about. Defaults to `maxStatusChecks`.
   */
  maxConcurrentGitProcesses?: number;
}

export class WorktreeStatusService {
  private gitInstances = new GitClientCache();
  private logger: Logger;
  // One budget for every git process this service spawns, shared by all
  // worktrees. A single snapshot fans out to five commands at once, and the
  // prune phase asks for `maxStatusChecks` snapshots in parallel — so without a
  // shared ceiling that setting bounded worktrees rather than processes and the
  // real peak was five times what the user configured. A slot is held around a
  // single git command only, never around a helper that runs more of them, so
  // the budget can never wait on itself.
  //
  // The trade: these clients carry no inactivity timeout (see createGitInstance),
  // so a git command that hangs now holds a shared slot instead of delaying only
  // its own worktree, and `maxStatusChecks` hung commands stall every remaining
  // probe. Giving status clients a block timeout is the fix, and a change with
  // its own risk — `git status` is legitimately silent on a large worktree.
  private readonly gitBudget: LimitFunction;

  constructor(
    private readonly config: WorktreeStatusServiceConfig = {},
    logger?: Logger,
  ) {
    this.logger = logger ?? Logger.createDefault();
    this.gitBudget = pLimit(
      Math.max(1, config.maxConcurrentGitProcesses ?? DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS),
    );
  }

  updateLogger(logger: Logger): void {
    this.logger = logger;
  }

  /** Runs one git command against the shared process budget. */
  private runGit<T>(command: () => Promise<T>): Promise<T> {
    return this.gitBudget(command);
  }

  // Only gates fast-forwards, which never touch a submodule's working tree, so
  // the repository's own `submodule.<name>.ignore` is respected here. Forcing
  // `--ignore-submodules=none` would override the standard way repos keep
  // vendored build output from dirtying the superproject, and a worktree that
  // reads as permanently dirty silently stops updating. Removal is the decision
  // that must not be fooled by a quiet submodule — see getFullWorktreeStatus.
  async checkWorktreeStatus(worktreePath: string): Promise<boolean> {
    const worktreeGit = this.createGitInstance(worktreePath);
    const status = await this.runGit(() => worktreeGit.status());

    const hasTrackedChanges =
      status.modified.length > 0 ||
      status.deleted.length > 0 ||
      status.renamed.length > 0 ||
      status.created.length > 0 ||
      status.conflicted.length > 0;

    if (hasTrackedChanges) {
      return false;
    }

    // `status.not_added` is already the untracked-and-not-ignored list: git
    // only writes a path to a `??` line when no exclude rule matched it, and
    // even `--ignored` (which nothing here passes) reports ignored paths on
    // separate `!!` lines that simple-git parses into `status.ignored`. See
    // untracked-ignored-status.e2e.test.ts.
    return status.not_added.length === 0;
  }

  async getFullWorktreeStatus(
    worktreePath: string,
    includeDetails = false,
    lastSyncCommit?: string,
    lastKnownRemoteTip?: LastKnownRemoteTip,
  ): Promise<WorktreeStatusResult> {
    const pathProbe = await probePathExists(worktreePath);
    if (pathProbe === "missing") {
      return {
        isClean: true,
        hasUnpushedCommits: false,
        hasStashedChanges: false,
        hasOperationInProgress: false,
        hasModifiedSubmodules: false,
        upstreamGone: false,
        fullyPushedUpstreamDeleted: false,
        canRemove: true,
        reasons: [],
        divergence: null,
      };
    }
    // A failed probe (EMFILE/EINTR under load) is indistinguishable from a live
    // worktree — never report it as removable.
    if (pathProbe === "unknown") {
      return {
        isClean: false,
        hasUnpushedCommits: true,
        hasStashedChanges: true,
        hasOperationInProgress: true,
        hasModifiedSubmodules: true,
        upstreamGone: false,
        fullyPushedUpstreamDeleted: false,
        canRemove: false,
        reasons: ["cannot verify worktree path (filesystem probe failed)"],
        divergence: null,
      };
    }

    const snap = await this.collectSnapshot(worktreePath, lastSyncCommit, lastKnownRemoteTip);

    const isClean = this.deriveIsClean(snap);
    // Removal requires BOTH unpushed checks to pass independently: commits
    // missing from every remote AND commits made since the last sync. Relying
    // on lastSyncCommit alone hides unpushed work when metadata records HEAD.
    const anyRemoteUnpushed = (snap.unpushedAnyRemoteCount ?? 1) > 0;
    const sinceSyncUnpushed = snap.sinceSyncChecked && (snap.sinceSyncCount ?? 1) > 0;
    const hasUnpushedCommits = !snap.detached && (anyRemoteUnpushed || sinceSyncUnpushed);
    // "Unpushed" override for squash-merge + branch deletion: only when the
    // recorded upstream ref is verifiably gone from a non-empty remote-branch
    // list (an empty list means the fetch may have failed — fail closed) AND
    // HEAD is an ancestor of the tip recorded while the ref still existed.
    const recordedRefGone =
      lastKnownRemoteTip !== undefined &&
      snap.remoteBranches.length > 0 &&
      !snap.remoteBranches.includes(lastKnownRemoteTip.ref);
    const fullyPushedUpstreamDeleted = hasUnpushedCommits && recordedRefGone && snap.headPushedToRecordedTip === true;
    const hasStashedChanges = snap.stashTotal === null ? true : snap.stashTotal > 0;
    const hasOperationInProgress =
      snap.gitDir === null ? true : snap.operationFile !== null || snap.operationProbeUnknown;
    const hasModifiedSubmodules = this.deriveModifiedSubmodules(snap).length > 0 || snap.submoduleStatus === null;
    const upstreamGone =
      !snap.detached && snap.upstream !== null && snap.remoteBranches.length > 0
        ? !snap.remoteBranches.includes(snap.upstream)
        : false;

    // Ahead/behind against @{upstream}, read off the `## <branch>...<upstream>
    // [ahead N, behind M]` header `git status -b` already printed. It is the
    // same symmetric-difference count `rev-list --left-right --count
    // HEAD...@{upstream}` answers with, so the MCP layer no longer spawns that
    // rev-list per worktree (it used to, through a getDivergence helper that
    // also built a client of its own, outside this service's process budget).
    //
    // `snap.upstream !== null` is the condition under which that rev-list used
    // to succeed, on every state an intact repository reaches: the rev-parse
    // that produced it resolves @{upstream} to an existing remote-tracking ref,
    // and fails otherwise -- with "no upstream configured" when nothing is
    // tracked, and with exit 128 and "fatal: ambiguous argument" when the
    // tracked ref has been deleted, even though `git status` still prints its
    // name with `[gone]` and 0/0. A detached HEAD fails it too, and an unborn
    // branch never gets here (no current branch, so `detached`). So a worktree
    // with nothing to compare against keeps reporting null rather than a
    // fabricated 0/0, which is what every caller already reads as "cannot say".
    // Checked against real git on: in sync, ahead, behind, diverged, upstream
    // force-rebased, unrelated histories, a local branch as upstream, a
    // non-origin remote, a shallow clone, 250/120 counts, no upstream, a pruned
    // upstream, an unborn branch and a detached HEAD.
    //
    // The two answers do come apart in one place, and it is not "exactly":
    // where the remote-tracking ref exists but its object does not -- a ref
    // left pointing at a missing oid, or at a non-commit. `rev-parse
    // --abbrev-ref` answers from the ref name alone and succeeds, while `git
    // status` needs the commit, cannot compare, and prints `[gone]`, which
    // simple-git parses as 0/0. So a corrupt upstream ref reports 0/0 where the
    // rev-list reported null. Telling that apart would cost back the
    // per-worktree process this removed, and the same snapshot already reports
    // it: an upstream that is not in `git branch -r` sets upstreamGone, so the
    // worktree is labelled stale either way. Narrowing the guard to a
    // remote-tracking upstream is not the fix -- it would turn a branch that
    // tracks a local branch into a null, which is the local-upstream case in
    // worktree-divergence.e2e.test.ts.
    const divergence =
      snap.status !== null && snap.upstream !== null ? { ahead: snap.status.ahead, behind: snap.status.behind } : null;

    const reasons: string[] = [];
    if (!isClean) reasons.push("uncommitted changes");
    if (hasUnpushedCommits && !fullyPushedUpstreamDeleted) reasons.push("unpushed commits");
    if (hasStashedChanges) reasons.push("stashed changes");
    if (hasOperationInProgress) reasons.push("operation in progress");
    if (hasModifiedSubmodules) reasons.push("modified submodules");
    if (upstreamGone) reasons.push("upstream gone");
    // A detached HEAD may sit on commits unreachable from any ref; this tool
    // only manages branch-tracking worktrees, so never auto-remove one.
    if (snap.detached) reasons.push("detached HEAD");

    const canRemove =
      isClean &&
      (!hasUnpushedCommits || fullyPushedUpstreamDeleted) &&
      !hasStashedChanges &&
      !hasOperationInProgress &&
      !hasModifiedSubmodules &&
      !snap.detached;

    const details: WorktreeStatusDetails | undefined = includeDetails ? this.buildStatusDetails(snap) : undefined;

    return {
      isClean,
      hasUnpushedCommits,
      hasStashedChanges,
      hasOperationInProgress,
      hasModifiedSubmodules,
      upstreamGone,
      fullyPushedUpstreamDeleted,
      canRemove,
      reasons,
      divergence,
      details,
    };
  }

  private async collectSnapshot(
    worktreePath: string,
    lastSyncCommit?: string,
    lastKnownRemoteTip?: LastKnownRemoteTip,
  ): Promise<WorktreeSnapshot> {
    const git = this.createGitInstance(worktreePath);

    const [status, branchResult, remoteBranchesResult, stashResult, submoduleResult, gitDirResult] = await Promise.all([
      this.runGit(() => git.status(["--ignore-submodules=none"])).catch((e: unknown) => {
        this.logger.error(`Error reading status for ${worktreePath}`, e);
        return null;
      }),
      this.runGit(() => git.branch()).catch(() => null),
      this.runGit(() => git.branch(["-r", "--no-color"])).catch(() => null),
      this.listStashes(git).catch((e: unknown) => {
        this.logger.error(`Error checking stash`, e);
        return null;
      }),
      this.runGit(() => git.raw(["submodule", "status"])).catch((e: unknown) => {
        this.logger.error(`Error checking submodule status`, e);
        return null;
      }),
      this.resolveGitDir(worktreePath).catch((e: unknown) => {
        this.logger.error(`Error checking operation in progress for ${worktreePath}`, e);
        return null;
      }),
    ]);

    const currentBranch = branchResult?.current ?? null;
    const detached = !branchResult?.current || Boolean((branchResult as { detached?: boolean })?.detached);

    let upstream: string | null = null;
    let unpushedAnyRemoteCount: number | null = null;
    let sinceSyncCount: number | null = null;
    let headPushedToRecordedTip: boolean | null = null;
    if (!detached && currentBranch) {
      const [upstreamResult, anyRemoteResult, sinceSyncResult, recordedTipResult] = await Promise.all([
        this.runGit(() => git.raw(["rev-parse", "--abbrev-ref", `${currentBranch}@{upstream}`])).then(
          (raw) => ({ ok: true as const, value: raw }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
        // HEAD, never the short branch name: git resolves a bare name through
        // refs/tags/<name> before refs/heads/<name>, so a tag sharing the
        // branch's name (`git checkout -b 1.4.2 1.4.2`) answers for the tag —
        // with nothing but `warning: refname '<name>' is ambiguous.` on stderr
        // and exit 0 — and local-only commits count as zero, which would let
        // the prune pipeline remove the worktree. The branch is checked out
        // here (the !detached guard above), so HEAD is exactly its tip.
        this.runGit(() => git.raw(["rev-list", "--count", "HEAD", "--not", "--remotes"])).then(
          (raw) => ({ ok: true as const, value: raw }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
        lastSyncCommit
          ? this.runGit(() => git.raw(["rev-list", "--count", `${lastSyncCommit}..HEAD`])).then(
              (raw) => ({ ok: true as const, value: raw }),
              (error: unknown) => ({ ok: false as const, error }),
            )
          : Promise.resolve(null),
        // Zero commits in <tip>..HEAD ⟺ HEAD is the recorded tip or behind it.
        // NOT merge-base --is-ancestor: simple-git resolves its silent exit-1
        // ("not an ancestor") as success because nothing is written to stderr.
        // Any failure (e.g. the recorded oid was gc'd) reads as "not proven".
        lastKnownRemoteTip
          ? this.runGit(() => git.raw(["rev-list", "--count", `${lastKnownRemoteTip.oid}..HEAD`])).then(
              (raw) => this.parseCount(raw) === 0,
              () => false,
            )
          : Promise.resolve(null),
      ]);

      headPushedToRecordedTip = recordedTipResult;

      if (upstreamResult.ok) {
        upstream = upstreamResult.value.trim() || null;
      } else {
        const errorMessage = getErrorMessage(upstreamResult.error);
        if (
          !errorMessage.includes("fatal: no upstream configured") &&
          !errorMessage.includes("no upstream configured for branch") &&
          !errorMessage.includes("fatal: ambiguous argument") &&
          !errorMessage.includes("unknown revision or path")
        ) {
          this.logger.error(`Unexpected error checking upstream status for ${worktreePath}: ${errorMessage}`);
        }
      }

      if (anyRemoteResult.ok) {
        unpushedAnyRemoteCount = this.parseCount(anyRemoteResult.value);
      } else {
        this.logger.error(`Error checking unpushed commits`, anyRemoteResult.error);
      }

      if (sinceSyncResult) {
        if (sinceSyncResult.ok) {
          sinceSyncCount = this.parseCount(sinceSyncResult.value);
        } else {
          this.logger.error(`Error checking commits since last sync`, sinceSyncResult.error);
        }
      }
    }

    // A failed `git branch` leaves the checked-out branch unknown (undefined),
    // which counts every stash that names a branch; detached HEAD is null.
    const stashTotal = stashResult
      ? await this.countOwnStashes(
          git,
          stashResult,
          branchResult === null ? undefined : detached ? null : currentBranch,
        )
      : null;

    const operationProbe = gitDirResult ? await this.detectOperationFile(gitDirResult) : { file: null, unknown: false };

    // Untracked-and-not-ignored straight from status — see checkWorktreeStatus.
    const untrackedNotIgnored = status?.not_added ?? [];

    return {
      exists: true,
      status,
      currentBranch,
      detached,
      remoteBranches: remoteBranchesResult?.all ?? [],
      upstream,
      unpushedAnyRemoteCount,
      sinceSyncCount,
      sinceSyncChecked: lastSyncCommit !== undefined,
      headPushedToRecordedTip,
      stashTotal,
      submoduleStatus: submoduleResult,
      operationFile: operationProbe.file,
      operationProbeUnknown: operationProbe.unknown,
      gitDir: gitDirResult,
      untrackedNotIgnored,
    };
  }

  private parseCount(raw: string): number | null {
    const count = parseInt(raw.trim(), 10);
    return Number.isNaN(count) ? null : count;
  }

  private deriveIsClean(snap: WorktreeSnapshot): boolean {
    const status = snap.status;
    if (!status) return false;
    const hasTracked =
      status.modified.length > 0 ||
      status.deleted.length > 0 ||
      status.renamed.length > 0 ||
      status.created.length > 0 ||
      status.conflicted.length > 0;
    if (hasTracked) return false;
    return snap.untrackedNotIgnored.length === 0;
  }

  private deriveModifiedSubmodules(snap: WorktreeSnapshot): string[] {
    if (!snap.submoduleStatus) return [];
    return collectModifiedSubmodules(snap.submoduleStatus);
  }

  private buildStatusDetails(snap: WorktreeSnapshot): WorktreeStatusDetails {
    const status = snap.status;
    const details: WorktreeStatusDetails = {
      modifiedFiles: status?.modified.length ?? 0,
      deletedFiles: status?.deleted.length ?? 0,
      renamedFiles: status?.renamed.length ?? 0,
      createdFiles: status?.created.length ?? 0,
      conflictedFiles: status?.conflicted.length ?? 0,
      untrackedFiles: snap.untrackedNotIgnored.length,
    };
    if (status) {
      if (status.modified.length > 0) details.modifiedFilesList = status.modified;
      if (status.deleted.length > 0) details.deletedFilesList = status.deleted;
      if (status.renamed.length > 0) {
        details.renamedFilesList = status.renamed.map((r) => ({ from: r.from, to: r.to }));
      }
      if (status.created.length > 0) details.createdFilesList = status.created;
      if (status.conflicted.length > 0) details.conflictedFilesList = status.conflicted;
    }
    if (snap.untrackedNotIgnored.length > 0) details.untrackedFilesList = snap.untrackedNotIgnored;
    const unpushedCount = snap.unpushedAnyRemoteCount ?? snap.sinceSyncCount;
    if (!snap.detached && unpushedCount !== null) details.unpushedCommitCount = unpushedCount;
    if (snap.stashTotal !== null) details.stashCount = snap.stashTotal;
    const opType = this.operationTypeFromFile(snap.operationFile);
    if (opType) details.operationType = opType;
    const modSubs = this.deriveModifiedSubmodules(snap);
    if (modSubs.length > 0) details.modifiedSubmodules = modSubs;
    return details;
  }

  private operationTypeFromFile(file: string | null): string | undefined {
    if (!file) return undefined;
    return OPERATION_FILES.find((op) => op.file === file)?.type;
  }

  private async detectOperationFile(gitDir: string): Promise<{ file: string | null; unknown: boolean }> {
    const results = await Promise.all(
      OPERATION_FILES.map(({ file }) =>
        fs.access(path.join(gitDir, file)).then(
          () => "present" as const,
          (error: unknown) =>
            (error as NodeJS.ErrnoException).code === "ENOENT" ? ("absent" as const) : ("unknown" as const),
        ),
      ),
    );
    const idx = results.findIndex((result) => result === "present");
    if (idx >= 0) return { file: OPERATION_FILES[idx].file, unknown: false };
    // An unreadable probe may be hiding MERGE_HEAD etc. — report it so the
    // caller treats the worktree as having an operation in progress.
    return { file: null, unknown: results.includes("unknown") };
  }

  async hasStashedChanges(worktreePath: string): Promise<boolean> {
    const worktreeGit = this.createGitInstance(worktreePath);

    try {
      const [stashList, branchSummary] = await Promise.all([
        this.listStashes(worktreeGit),
        this.runGit(() => worktreeGit.branch()).catch(() => null),
      ]);
      if (stashList.total === 0) return false;
      const currentBranch =
        branchSummary === null
          ? undefined
          : !branchSummary.current || branchSummary.detached
            ? null
            : branchSummary.current;
      return (await this.countOwnStashes(worktreeGit, stashList, currentBranch)) > 0;
    } catch (error) {
      this.logger.error(`Error checking stash`, error);
      return true; // Conservative: assume unsafe to delete
    }
  }

  // simple-git types stashList's options as flat CLI options, but it parses a
  // `format` map exactly as it does for `git log` (the fields come back on
  // each entry of `all`).
  private listStashes(git: SimpleGit): Promise<StashListing> {
    return this.runGit(() =>
      git.stashList({ format: STASH_LIST_FORMAT } as unknown as Parameters<SimpleGit["stashList"]>[0]),
    );
  }

  /**
   * How many entries of the repository-wide stash list belong to this
   * worktree (see STASH_LIST_FORMAT).
   *
   * @param currentBranch the checked-out branch; null for a detached HEAD;
   *   undefined when it could not be read, which counts every named stash.
   */
  private async countOwnStashes(
    git: SimpleGit,
    listing: StashListing,
    currentBranch: string | null | undefined,
  ): Promise<number> {
    const entries = (listing.all ?? []) as unknown as ReadonlyArray<Partial<StashEntry>>;
    // Entries that did not parse cannot be attributed: count them all.
    if (entries.length !== listing.total) return listing.total;

    const baseReachable = new Map<string, Promise<boolean>>();
    let count = 0;
    for (const entry of entries) {
      const branch = stashSubjectBranch(entry.subject ?? "");
      if (branch !== null) {
        // The stash names its branch: it belongs to whichever worktree has
        // that branch checked out, and to no other.
        if (currentBranch === undefined || branch === currentBranch) count++;
        continue;
      }
      // A detached-HEAD stash or a custom `git stash store -m` subject names
      // no branch. Its first parent is the commit it was made on; count it
      // here when that commit is in this worktree's history, and whenever
      // that cannot be established.
      const base = (entry.parents ?? "").trim().split(/\s+/)[0];
      if (!/^[0-9a-f]+$/i.test(base)) {
        count++;
        continue;
      }
      let reachable = baseReachable.get(base);
      if (!reachable) {
        reachable = this.isInHeadHistory(git, base);
        baseReachable.set(base, reachable);
      }
      if (await reachable) count++;
    }
    return count;
  }

  // Zero commits in HEAD..<oid> ⟺ oid is HEAD or one of its ancestors. Not
  // merge-base --is-ancestor: simple-git resolves its silent exit 1 as success.
  // Any failure answers true, the conservative side for a safety gate.
  private isInHeadHistory(git: SimpleGit, oid: string): Promise<boolean> {
    return this.runGit(() => git.raw(["rev-list", "--count", `HEAD..${oid}`])).then(
      (raw) => {
        const count = this.parseCount(raw);
        return count === null || count === 0;
      },
      () => true,
    );
  }

  async hasModifiedSubmodules(worktreePath: string): Promise<boolean> {
    const worktreeGit = this.createGitInstance(worktreePath);

    try {
      const result = await this.runGit(() => worktreeGit.raw(["submodule", "status"]));
      return collectModifiedSubmodules(result).length > 0;
    } catch (error) {
      this.logger.error(`Error checking submodule status`, error);
      return true;
    }
  }

  async hasOperationInProgress(worktreePath: string): Promise<boolean> {
    try {
      const gitDir = await this.resolveGitDir(worktreePath);
      const probe = await this.detectOperationFile(gitDir);
      return probe.unknown || probe.file !== null;
    } catch (error) {
      this.logger.error(`Error checking operation in progress for ${worktreePath}`, error);
      return true;
    }
  }

  async validateWorktreeForRemoval(
    worktreePath: string,
    lastSyncCommit?: string,
    lastKnownRemoteTip?: LastKnownRemoteTip,
  ): Promise<void> {
    const status = await this.getFullWorktreeStatus(worktreePath, false, lastSyncCommit, lastKnownRemoteTip);

    if (!status.canRemove) {
      throw new WorktreeNotCleanError(worktreePath, status.reasons);
    }
  }

  private async resolveGitDir(worktreePath: string): Promise<string> {
    const gitPath = path.join(worktreePath, PATH_CONSTANTS.GIT_DIR);

    try {
      const stat = await fs.stat(gitPath);

      if (stat.isFile()) {
        const content = await fs.readFile(gitPath, "utf-8");
        const gitdirMatch = content.match(new RegExp(`^${GIT_CONSTANTS.GITDIR_PREFIX}\\s*(.+)$`, "m"));
        if (gitdirMatch) {
          return path.resolve(worktreePath, gitdirMatch[1].trim());
        }
        throw new GitOperationError("resolve-git-dir", `Failed to parse gitdir from .git file at ${gitPath}`);
      }

      return gitPath;
    } catch (error) {
      throw new GitOperationError(
        "resolve-git-dir",
        `Failed to resolve .git directory for ${worktreePath}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  private createGitInstance(worktreePath: string): SimpleGit {
    return this.gitInstances.get(worktreePath, this.config.skipLfs ? "1" : "0", () =>
      // createGitClient carries the (sanitized) process env: without HOME /
      // XDG_CONFIG_HOME git ignores the global excludes file and every
      // globally-ignored file reads as an untracked change, and without PATH
      // the spawn itself can fail.
      createGitClient(worktreePath, this.config.skipLfs ? { [ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE]: "1" } : {}),
    );
  }

  /**
   * Drops the client cached for a worktree that no longer exists. Called by
   * GitService, which owns this service and is where every removal lands — a
   * status client is built per worktree path, so without this the cache keeps
   * one for every branch the repository ever had.
   */
  forgetWorktree(worktreePath: string): void {
    this.gitInstances.forget(worktreePath);
  }
}
