import * as fs from "fs/promises";
import * as path from "path";

import pLimit from "p-limit";

import { DEFAULT_CONFIG, ENV_CONSTANTS, GIT_CONSTANTS, GIT_OPERATIONS, PATH_CONSTANTS } from "../constants";
import { GitOperationError, WorktreeNotCleanError } from "../errors";
import { probePathExists } from "../utils/file-exists";
import { createGitClient } from "../utils/git-client";
import { GitClientCache } from "../utils/git-client-cache";

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

// Every local branch and remote-tracking ref of a repository, from one
// `for-each-ref`. refs/heads and refs/remotes live in the common git dir, so
// the answer is the same from every worktree: a caller probing many worktrees
// of one repository shares a single scan through a RefScanScope instead of
// each snapshot listing them again.
//
// %(upstream) is the full ref a branch tracks, derived from its
// branch.<name>.remote/merge config -- refs/remotes/<remote>/<b> for a remote,
// refs/heads/<b> for `remote = .` -- and it is printed whether or not that ref
// still exists. That is what tells a pruned upstream (configured, absent) from
// no upstream at all, which `rev-parse <b>@{upstream}` cannot: it fails the
// same way for both. Only names are read, never objects: a %(objecttype) would
// make one ref pointing at a missing object fail the whole scan. Fields are
// NUL-separated because a refname can hold neither NUL nor newline.
const REF_SCAN_ARGS = [
  "for-each-ref",
  "--format=%(refname)%00%(upstream)%00%(symref)",
  GIT_CONSTANTS.REFS.HEADS,
  "refs/remotes/",
];
const REMOTE_TRACKING_PREFIX = "refs/remotes/";

export interface RefScan {
  /** Full names of every branch and remote-tracking ref, symrefs excluded. */
  refs: ReadonlySet<string>;
  /** Whether any remote-tracking ref exists at all. */
  hasRemoteRefs: boolean;
  /** Each local branch's full upstream ref by branch name; "" when it tracks nothing. */
  upstreams: ReadonlyMap<string, string>;
}

export function parseRefScan(raw: string): RefScan {
  const refs = new Set<string>();
  const upstreams = new Map<string, string>();
  let hasRemoteRefs = false;
  for (const line of raw.split("\n")) {
    const [ref, upstream = "", symref = ""] = line.split("\0");
    // A symref (refs/remotes/origin/HEAD) is an alias, not a branch.
    if (!ref || symref) continue;
    refs.add(ref);
    if (ref.startsWith(GIT_CONSTANTS.REFS.HEADS)) {
      upstreams.set(ref.slice(GIT_CONSTANTS.REFS.HEADS.length), upstream);
    } else if (ref.startsWith(REMOTE_TRACKING_PREFIX)) {
      hasRemoteRefs = true;
    }
  }
  return { refs, hasRemoteRefs, upstreams };
}

/**
 * Shares one ref scan per repository between every status snapshot taken
 * with it. Create one per pass over a set of worktrees (a sync tick's prune
 * checks, one listing) and drop it afterwards: the scan is a point-in-time
 * read, so a decision that must see the refs as they are now -- the re-check
 * right before a removal -- takes a snapshot without one.
 */
export class RefScanScope {
  private readonly scans = new Map<string, Promise<RefScan | null>>();

  /** The scan already started for this common git dir, or `scan()`'s. */
  share(commonDir: string, scan: () => Promise<RefScan | null>): Promise<RefScan | null> {
    let pending = this.scans.get(commonDir);
    if (!pending) {
      pending = scan();
      this.scans.set(commonDir, pending);
    }
    return pending;
  }
}

// What a snapshot knows about the checked-out branch's upstream:
//   none     no upstream configured, or no branch checked out
//   present  the upstream ref exists
//   gone     an upstream is configured and its ref does not exist
//   unknown  the ref scan failed, or does not know this branch
type UpstreamState = "none" | "present" | "gone" | "unknown";

interface WorktreeSnapshot {
  exists: boolean;
  status: Awaited<ReturnType<SimpleGit["status"]>> | null;
  currentBranch: string | null;
  detached: boolean;
  // A plain detached HEAD: detached with no rebase or bisect in progress (and
  // the operation probe answered). Only then is the unpushed gate waived; a
  // paused rebase also reads as detached but sits on the branch's own commits.
  plainDetached: boolean;
  upstream: UpstreamState;
  // lastKnownRemoteTip's ref is verifiably absent from a scan that saw
  // remote-tracking refs (none at all may mean a failed fetch: fail closed).
  recordedRefGone: boolean;
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

export interface FullWorktreeStatusOptions {
  /** HEAD as of the last sync; commits made since then count as unpushed. */
  lastSyncCommit?: string;
  /** The upstream ref and tip recorded while it existed (squash-merge override). */
  lastKnownRemoteTip?: LastKnownRemoteTip;
  /** Shares one ref scan between every worktree probed with it in one pass. */
  refScans?: RefScanScope;
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
  // worktrees. A single snapshot fans out to four commands at once, and the
  // prune phase asks for `maxStatusChecks` snapshots in parallel — so without a
  // shared ceiling that setting bounded worktrees rather than processes and the
  // real peak was a multiple of what the user configured. A slot is held around a
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
    { lastSyncCommit, lastKnownRemoteTip, refScans }: FullWorktreeStatusOptions = {},
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

    const snap = await this.collectSnapshot(worktreePath, lastSyncCommit, lastKnownRemoteTip, refScans);

    const isClean = this.deriveIsClean(snap);
    // Removal requires BOTH unpushed checks to pass independently: commits
    // missing from every remote AND commits made since the last sync. Relying
    // on lastSyncCommit alone hides unpushed work when metadata records HEAD.
    const anyRemoteUnpushed = (snap.unpushedAnyRemoteCount ?? 1) > 0;
    const sinceSyncUnpushed = snap.sinceSyncChecked && (snap.sinceSyncCount ?? 1) > 0;
    const hasUnpushedCommits = !snap.plainDetached && (anyRemoteUnpushed || sinceSyncUnpushed);
    // "Unpushed" override for squash-merge + branch deletion: only when the
    // recorded upstream ref is verifiably gone (see recordedRefGone) AND HEAD
    // is an ancestor of the tip recorded while the ref still existed.
    const fullyPushedUpstreamDeleted =
      hasUnpushedCommits && snap.recordedRefGone && snap.headPushedToRecordedTip === true;
    const hasStashedChanges = snap.stashTotal === null ? true : snap.stashTotal > 0;
    const hasOperationInProgress =
      snap.gitDir === null ? true : snap.operationFile !== null || snap.operationProbeUnknown;
    const hasModifiedSubmodules = this.deriveModifiedSubmodules(snap).length > 0 || snap.submoduleStatus === null;
    const upstreamGone = snap.upstream === "gone";

    // Ahead/behind against @{upstream}, read off the `## <branch>...<upstream>
    // [ahead N, behind M]` header `git status -b` already printed. It is the
    // same symmetric-difference count `rev-list --left-right --count
    // HEAD...@{upstream}` answers with, so no rev-list is spawned for it.
    //
    // Reported only when the upstream ref exists. For a pruned upstream `git
    // status` still prints its name with `[gone]`, which simple-git parses as
    // 0/0, and a fabricated 0/0 reads as "in sync" to every caller -- null is
    // "cannot say". The ref scan (see RefScan) knows which upstream is
    // configured and whether its ref exists, for a remote-tracking upstream
    // and a local-branch one (`branch.<b>.remote = .`) alike. Checked against
    // real git on: in sync, ahead, behind, diverged, a local branch as
    // upstream, no upstream, a pruned upstream and a deleted local upstream;
    // see worktree-divergence.e2e.test.ts.
    //
    // Where the upstream ref exists but its object does not (a ref left
    // pointing at a missing oid) the scan, which reads names only, reports it
    // present while `git status` cannot compare and prints `[gone]`: that
    // corrupt state reads as 0/0. Telling it apart would need a process that
    // reads the object, per worktree (FU-T101-5).
    const divergence =
      snap.status !== null && snap.upstream === "present"
        ? { ahead: snap.status.ahead, behind: snap.status.behind }
        : null;

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

  // Per worktree: `status`, `stash list`, `submodule status` and the
  // unpushed-commit rev-lists. The checked-out branch and whether HEAD is
  // detached come off the `## ` header `status -b` prints anyway, and what the
  // branch tracks and whether that ref still exists come from the
  // repository-wide ref scan, so no `git branch`, `branch -r` or `rev-parse
  // @{upstream}` is spawned per worktree.
  private async collectSnapshot(
    worktreePath: string,
    lastSyncCommit?: string,
    lastKnownRemoteTip?: LastKnownRemoteTip,
    refScans?: RefScanScope,
  ): Promise<WorktreeSnapshot> {
    const git = this.createGitInstance(worktreePath);

    const gitDirProbe = this.resolveGitDir(worktreePath);
    const [status, refScan, stashResult, submoduleResult, gitDirResult] = await Promise.all([
      this.runGit(() => git.status(["--ignore-submodules=none"])).catch((e: unknown) => {
        this.logger.error(`Error reading status for ${worktreePath}`, e);
        return null;
      }),
      this.scanRefsFor(git, gitDirProbe, refScans),
      this.listStashes(git).catch((e: unknown) => {
        this.logger.error(`Error checking stash`, e);
        return null;
      }),
      this.runGit(() => git.raw(["submodule", "status"])).catch((e: unknown) => {
        this.logger.error(`Error checking submodule status`, e);
        return null;
      }),
      gitDirProbe.catch((e: unknown) => {
        this.logger.error(`Error checking operation in progress for ${worktreePath}`, e);
        return null;
      }),
    ]);

    // `## HEAD (no branch)` -- a detached HEAD, and also a rebase or bisect in
    // progress -- is the one header simple-git reports as detached. A failed
    // status leaves the branch unknown: not detached (which would waive the
    // unpushed-commit gate), and with no branch to run the unpushed probes
    // for, so it reports unpushed commits (fail closed).
    const detached = status?.detached ?? false;
    const currentBranch = status && !detached ? status.current || null : null;

    const upstream = this.upstreamState(refScan, currentBranch);
    const recordedRefGone =
      lastKnownRemoteTip !== undefined &&
      refScan !== null &&
      refScan.hasRemoteRefs &&
      !refScan.refs.has(`${REMOTE_TRACKING_PREFIX}${lastKnownRemoteTip.ref}`);

    // A rebase or bisect in progress also prints `## HEAD (no branch)`, so it
    // reads as detached; its HEAD is the branch being worked on, replayed or
    // not, and must not waive the unpushed gate. An unanswered operation probe
    // counts as one in progress (fail closed).
    const operationProbe = gitDirResult ? await this.detectOperationFile(gitDirResult) : { file: null, unknown: false };
    const operationRunning = gitDirResult === null || operationProbe.file !== null || operationProbe.unknown;
    const plainDetached = detached && !operationRunning;

    let unpushedAnyRemoteCount: number | null = null;
    let sinceSyncCount: number | null = null;
    let headPushedToRecordedTip: boolean | null = null;
    // The probes below all ask about HEAD, so they run for a checked-out branch
    // and for a detached HEAD mid-operation alike.
    if (currentBranch || (detached && !plainDetached)) {
      const [anyRemoteResult, sinceSyncResult, recordedTipResult] = await Promise.all([
        // HEAD, never the short branch name: git resolves a bare name through
        // refs/tags/<name> before refs/heads/<name>, so a tag sharing the
        // branch's name (`git checkout -b 1.4.2 1.4.2`) answers for the tag —
        // with nothing but `warning: refname '<name>' is ambiguous.` on stderr
        // and exit 0 — and local-only commits count as zero, which would let
        // the prune pipeline remove the worktree. HEAD is the checked-out
        // branch's tip, or where a paused rebase or bisect has it.
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
        // Only asked when the answer can matter: the proof is consulted only
        // once the recorded ref is gone, and while it exists the ordinary
        // unpushed check already covers the branch.
        lastKnownRemoteTip && recordedRefGone
          ? this.runGit(() => git.raw(["rev-list", "--count", `${lastKnownRemoteTip.oid}..HEAD`])).then(
              (raw) => this.parseCount(raw) === 0,
              () => false,
            )
          : Promise.resolve(null),
      ]);

      headPushedToRecordedTip = recordedTipResult;

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

    // A failed status leaves the checked-out branch unknown (undefined), which
    // counts every stash that names a branch; so does a rebase or bisect in
    // progress, whose HEAD is detached while the stashes made before it name
    // the branch being worked on. A plain detached HEAD is null.
    const stashBranch = status === null || (detached && operationRunning) ? undefined : currentBranch;
    const stashTotal = stashResult ? await this.countOwnStashes(git, stashResult, stashBranch) : null;

    // Untracked-and-not-ignored straight from status — see checkWorktreeStatus.
    const untrackedNotIgnored = status?.not_added ?? [];

    return {
      exists: true,
      status,
      currentBranch,
      detached,
      plainDetached,
      upstream,
      recordedRefGone,
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

  // Resolves FU-T101-1 and FU-T101-2: the upstream is the full ref the scan
  // derived from branch.<b>.remote/merge, so a branch tracking a local branch
  // is judged against refs/heads (not against remote-tracking refs it can
  // never be among), and a pruned upstream still has a name to be missing.
  private upstreamState(scan: RefScan | null, branch: string | null): UpstreamState {
    if (branch === null) return "none";
    // No scan, or a branch it has never heard of (unborn, or created since
    // the scan): nothing to judge by.
    const upstreamRef = scan?.upstreams.get(branch);
    if (scan === null || upstreamRef === undefined) return "unknown";
    if (upstreamRef === "") return "none";
    if (scan.refs.has(upstreamRef)) return "present";
    // No remote-tracking refs at all may be a failed fetch rather than a
    // deletion: do not call a remote upstream gone on that (fail closed).
    if (upstreamRef.startsWith(REMOTE_TRACKING_PREFIX) && !scan.hasRemoteRefs) return "unknown";
    return "gone";
  }

  /**
   * The ref scan for this worktree's repository: shared through `refScans`
   * when one is given, keyed by the common git dir so two worktrees of the
   * same repository share it and two repositories never do. Without a scope,
   * or when the common dir cannot be read, the snapshot scans on its own.
   */
  private async scanRefsFor(
    git: SimpleGit,
    gitDirProbe: Promise<string>,
    refScans: RefScanScope | undefined,
  ): Promise<RefScan | null> {
    if (refScans) {
      const commonDir = await gitDirProbe.then((gitDir) => this.resolveCommonDir(gitDir)).catch(() => null);
      if (commonDir !== null) return refScans.share(commonDir, () => this.scanRefs(git));
    }
    return this.scanRefs(git);
  }

  private scanRefs(git: SimpleGit): Promise<RefScan | null> {
    return this.runGit(() => git.raw(REF_SCAN_ARGS)).then(parseRefScan, (e: unknown) => {
      this.logger.error(`Error listing branches and remote-tracking refs`, e);
      return null;
    });
  }

  // A linked worktree's git dir names the shared one in its `commondir` file
  // (relative to itself); a main worktree's git dir is the common dir.
  private async resolveCommonDir(gitDir: string): Promise<string> {
    try {
      const content = await fs.readFile(path.join(gitDir, "commondir"), "utf-8");
      return path.resolve(gitDir, content.trim());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(gitDir);
      throw error;
    }
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
    if (!snap.plainDetached && unpushedCount !== null) details.unpushedCommitCount = unpushedCount;
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
      // During a rebase or bisect `git branch` prints `* (no branch, rebasing
      // <b>)`, which simple-git parses as a branch named "(no" -- not
      // detached. No branch name starts with "(", so that reads as unknown.
      const current = branchSummary?.current ?? "";
      const currentBranch =
        branchSummary === null || current.startsWith("(")
          ? undefined
          : !current || branchSummary.detached
            ? null
            : current;
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
    // simple-git derives `total` from `all.length`, so every entry is here.
    const entries = (listing.all ?? []) as unknown as ReadonlyArray<Partial<StashEntry>>;
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
    const status = await this.getFullWorktreeStatus(worktreePath, false, { lastSyncCommit, lastKnownRemoteTip });

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
