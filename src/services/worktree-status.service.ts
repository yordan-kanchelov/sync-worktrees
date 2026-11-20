import * as fs from "fs/promises";
import * as path from "path";

import pLimit from "p-limit";

import { DEFAULT_CONFIG, ENV_CONSTANTS, GIT_CONSTANTS, GIT_OPERATIONS, PATH_CONSTANTS } from "../constants";
import { GitOperationError } from "../errors";
import { probePathExists } from "../utils/file-exists";
import { createGitClient } from "../utils/git-client";
import { GitClientCache } from "../utils/git-client-cache";

import { Logger } from "./logger.service";

import type { LastKnownRemoteTip } from "../types/sync-metadata";
import type { LimitFunction } from "p-limit";
import type { SimpleGit, StatusResult } from "simple-git";

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
  fullyPushedUpstreamDeleted: boolean;
  canRemove: boolean;
  reasons: string[];
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

const STASH_LIST_FORMAT = { hash: "%H", parents: "%P", subject: "%gs" } as const;
const STASH_SUBJECT_BRANCH = /^(?:WIP on|On) ([^\s:]+):/;

interface StashEntry {
  hash: string;
  parents: string;
  subject: string;
}

export function stashSubjectBranch(subject: string): string | null {
  const match = STASH_SUBJECT_BRANCH.exec(subject);
  return match ? match[1] : null;
}

interface StashListing {
  readonly total: number;
  readonly all: ReadonlyArray<unknown>;
}

const REF_SCAN_ARGS = [
  "for-each-ref",
  "--format=%(refname)%00%(upstream)%00%(symref)",
  GIT_CONSTANTS.REFS.HEADS,
  "refs/remotes/",
];
const REMOTE_TRACKING_PREFIX = "refs/remotes/";

const MAX_NAMED_UNCOMMITTED_PATHS = 3;

export function unbucketedTrackedPaths(status: StatusResult): string[] {
  const bucketed = new Set([
    ...status.modified,
    ...status.deleted,
    ...status.renamed.map((r) => r.to),
    ...status.created,
    ...status.conflicted,
  ]);
  return status.files.filter((f) => f.index !== "?" && f.index !== "!" && !bucketed.has(f.path)).map((f) => f.path);
}

function hasTrackedChanges(status: StatusResult): boolean {
  return (
    status.modified.length > 0 ||
    status.deleted.length > 0 ||
    status.renamed.length > 0 ||
    status.created.length > 0 ||
    status.conflicted.length > 0 ||
    unbucketedTrackedPaths(status).length > 0
  );
}

export interface RefScan {
  refs: ReadonlySet<string>;
  hasRemoteRefs: boolean;
  upstreams: ReadonlyMap<string, string>;
}

export function parseRefScan(raw: string): RefScan {
  const refs = new Set<string>();
  const upstreams = new Map<string, string>();
  let hasRemoteRefs = false;
  for (const line of raw.split("\n")) {
    const [ref, upstream = "", symref = ""] = line.split("\0");
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

export class RefScanScope {
  private readonly scans = new Map<string, Promise<RefScan | null>>();
  private readonly stashes = new Map<string, Promise<StashListing | null>>();

  share(commonDir: string, scan: () => Promise<RefScan | null>): Promise<RefScan | null> {
    return shareOnce(this.scans, commonDir, scan);
  }

  shareStashes(commonDir: string, list: () => Promise<StashListing | null>): Promise<StashListing | null> {
    return shareOnce(this.stashes, commonDir, list);
  }
}

function shareOnce<T>(cache: Map<string, Promise<T>>, key: string, start: () => Promise<T>): Promise<T> {
  let pending = cache.get(key);
  if (!pending) {
    pending = start();
    cache.set(key, pending);
  }
  return pending;
}

type UpstreamState = "none" | "present" | "gone" | "unknown";

interface WorktreeSnapshot {
  status: Awaited<ReturnType<SimpleGit["status"]>> | null;
  currentBranch: string | null;
  detached: boolean;
  plainDetached: boolean;
  upstream: UpstreamState;
  recordedRefGone: boolean;
  unpushedAnyRemoteCount: number | null;
  sinceSyncCount: number | null;
  sinceSyncChecked: boolean;
  headPushedToRecordedTip: boolean | null;
  stashTotal: number | null;
  submoduleStatus: string | null;
  operationFile: string | null;
  operationProbeUnknown: boolean;
  gitDir: string | null;
  untrackedNotIgnored: string[];
}

export interface FullWorktreeStatusOptions {
  lastSyncCommit?: string;
  lastKnownRemoteTip?: LastKnownRemoteTip;
  refScans?: RefScanScope;
}

export interface WorktreeStatusServiceConfig {
  skipLfs?: boolean;
  maxConcurrentGitProcesses?: number;
  extraEnv?: Readonly<Record<string, string | undefined>>;
}

export class WorktreeStatusService {
  private gitInstances = new GitClientCache();
  private logger: Logger;
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

  private runGit<T>(command: () => Promise<T>): Promise<T> {
    return this.gitBudget(command);
  }

  async checkWorktreeStatus(worktreePath: string): Promise<boolean> {
    const worktreeGit = this.createGitInstance(worktreePath);
    const status = await this.runGit(() => worktreeGit.status());

    if (hasTrackedChanges(status)) return false;

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

    const divergence =
      snap.status !== null && snap.upstream === "present"
        ? { ahead: snap.status.ahead, behind: snap.status.behind }
        : null;

    const anyRemoteUnpushed = (snap.unpushedAnyRemoteCount ?? 1) > 0;
    const headOnUpstream = divergence !== null && divergence.ahead === 0;
    const sinceSyncUnpushed = snap.sinceSyncChecked && (snap.sinceSyncCount ?? 1) > 0 && !headOnUpstream;
    const hasUnpushedCommits = !snap.plainDetached && (anyRemoteUnpushed || sinceSyncUnpushed);
    const fullyPushedUpstreamDeleted =
      hasUnpushedCommits && snap.recordedRefGone && snap.headPushedToRecordedTip === true;
    const hasStashedChanges = snap.stashTotal === null ? true : snap.stashTotal > 0;
    const hasOperationInProgress =
      snap.gitDir === null ? true : snap.operationFile !== null || snap.operationProbeUnknown;
    const hasModifiedSubmodules = this.deriveModifiedSubmodules(snap).length > 0 || snap.submoduleStatus === null;
    const upstreamGone = snap.upstream === "gone";

    const reasons: string[] = [];
    if (!isClean) reasons.push(this.describeUncommitted(snap));
    if (hasUnpushedCommits && !fullyPushedUpstreamDeleted) reasons.push("unpushed commits");
    if (hasStashedChanges) reasons.push("stashed changes");
    if (hasOperationInProgress) reasons.push("operation in progress");
    if (hasModifiedSubmodules) reasons.push("modified submodules");
    if (upstreamGone) reasons.push("upstream gone");
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
    refScans?: RefScanScope,
  ): Promise<WorktreeSnapshot> {
    const git = this.createGitInstance(worktreePath);

    const gitDirProbe = this.resolveGitDir(worktreePath);
    const commonDirProbe = refScans
      ? gitDirProbe.then((gitDir) => this.resolveCommonDir(gitDir)).catch(() => null)
      : Promise.resolve(null);
    const listStashes = (): Promise<StashListing | null> =>
      this.listStashes(git).catch((e: unknown) => {
        this.logger.error(`Error checking stash`, e);
        return null;
      });
    const [status, refScan, stashResult, submoduleResult, gitDirResult] = await Promise.all([
      this.runGit(() => git.status(["--ignore-submodules=none"])).catch((e: unknown) => {
        this.logger.error(`Error reading status for ${worktreePath}`, e);
        return null;
      }),
      this.scanRefsFor(git, commonDirProbe, refScans),
      commonDirProbe.then((commonDir) =>
        refScans && commonDir !== null ? refScans.shareStashes(commonDir, listStashes) : listStashes(),
      ),
      this.runGit(() => git.raw(["submodule", "status"])).catch((e: unknown) => {
        this.logger.error(`Error checking submodule status`, e);
        return null;
      }),
      gitDirProbe.catch((e: unknown) => {
        this.logger.error(`Error checking operation in progress for ${worktreePath}`, e);
        return null;
      }),
    ]);

    const detached = status?.detached ?? false;
    const currentBranch = status && !detached ? status.current || null : null;

    const upstream = this.upstreamState(refScan, currentBranch);
    const recordedRefGone =
      lastKnownRemoteTip !== undefined &&
      refScan !== null &&
      refScan.hasRemoteRefs &&
      !refScan.refs.has(`${REMOTE_TRACKING_PREFIX}${lastKnownRemoteTip.ref}`);

    const operationProbe = gitDirResult ? await this.detectOperationFile(gitDirResult) : { file: null, unknown: false };
    const operationRunning = gitDirResult === null || operationProbe.file !== null || operationProbe.unknown;
    const plainDetached = detached && !operationRunning;

    let unpushedAnyRemoteCount: number | null = null;
    let sinceSyncCount: number | null = null;
    let headPushedToRecordedTip: boolean | null = null;
    if (currentBranch || (detached && !plainDetached)) {
      const countSince = (oid: string): Promise<string> =>
        this.runGit(() => git.raw(["rev-list", "--count", `${oid}..HEAD`]));
      const sinceSyncProbe = lastSyncCommit ? countSince(lastSyncCommit) : null;
      const [anyRemoteResult, sinceSyncResult, recordedTipResult] = await Promise.all([
        this.runGit(() => git.raw(["rev-list", "--count", "HEAD", "--not", "--remotes"])).then(
          (raw) => ({ ok: true as const, value: raw }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
        sinceSyncProbe
          ? sinceSyncProbe.then(
              (raw) => ({ ok: true as const, value: raw }),
              (error: unknown) => ({ ok: false as const, error }),
            )
          : Promise.resolve(null),
        lastKnownRemoteTip && recordedRefGone
          ? (sinceSyncProbe && lastKnownRemoteTip.oid === lastSyncCommit
              ? sinceSyncProbe
              : countSince(lastKnownRemoteTip.oid)
            ).then(
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

    const stashBranch = status === null || (detached && operationRunning) ? undefined : currentBranch;
    const stashTotal = stashResult ? await this.countOwnStashes(git, stashResult, stashBranch) : null;

    const untrackedNotIgnored = status?.not_added ?? [];

    return {
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

  private upstreamState(scan: RefScan | null, branch: string | null): UpstreamState {
    if (branch === null) return "none";
    const upstreamRef = scan?.upstreams.get(branch);
    if (scan === null || upstreamRef === undefined) return "unknown";
    if (upstreamRef === "") return "none";
    if (scan.refs.has(upstreamRef)) return "present";
    if (upstreamRef.startsWith(REMOTE_TRACKING_PREFIX) && !scan.hasRemoteRefs) return "unknown";
    return "gone";
  }

  private async scanRefsFor(
    git: SimpleGit,
    commonDirProbe: Promise<string | null>,
    refScans: RefScanScope | undefined,
  ): Promise<RefScan | null> {
    const commonDir = await commonDirProbe;
    if (refScans && commonDir !== null) return refScans.share(commonDir, () => this.scanRefs(git));
    return this.scanRefs(git);
  }

  private scanRefs(git: SimpleGit): Promise<RefScan | null> {
    return this.runGit(() => git.raw(REF_SCAN_ARGS)).then(parseRefScan, (e: unknown) => {
      this.logger.error(`Error listing branches and remote-tracking refs`, e);
      return null;
    });
  }

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
    if (hasTrackedChanges(status)) return false;
    return snap.untrackedNotIgnored.length === 0;
  }

  private describeUncommitted(snap: WorktreeSnapshot): string {
    const status = snap.status;
    if (!status) return "uncommitted changes";
    const tracked = new Set([
      ...status.modified,
      ...status.deleted,
      ...status.renamed.map((r) => r.to),
      ...status.created,
      ...status.conflicted,
      ...unbucketedTrackedPaths(status),
    ]);
    const untracked = snap.untrackedNotIgnored;
    if (tracked.size + untracked.length > MAX_NAMED_UNCOMMITTED_PATHS) {
      return `uncommitted changes (${tracked.size} tracked, ${untracked.length} untracked)`;
    }
    const names = [...[...tracked].map((p) => `'${p}'`), ...untracked.map((p) => `'${p}' (untracked)`)];
    return `uncommitted changes: ${names.join(", ")}`;
  }

  private deriveModifiedSubmodules(snap: WorktreeSnapshot): string[] {
    if (!snap.submoduleStatus) return [];
    return collectModifiedSubmodules(snap.submoduleStatus);
  }

  private buildStatusDetails(snap: WorktreeSnapshot): WorktreeStatusDetails {
    const status = snap.status;
    const modified = status ? [...status.modified, ...unbucketedTrackedPaths(status)] : [];
    const details: WorktreeStatusDetails = {
      modifiedFiles: modified.length,
      deletedFiles: status?.deleted.length ?? 0,
      renamedFiles: status?.renamed.length ?? 0,
      createdFiles: status?.created.length ?? 0,
      conflictedFiles: status?.conflicted.length ?? 0,
      untrackedFiles: snap.untrackedNotIgnored.length,
    };
    if (status) {
      if (modified.length > 0) details.modifiedFilesList = modified;
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
    return { file: null, unknown: results.includes("unknown") };
  }

  async hasStashedChanges(worktreePath: string): Promise<boolean> {
    const worktreeGit = this.createGitInstance(worktreePath);

    try {
      const [stashList, currentBranch] = await Promise.all([
        this.listStashes(worktreeGit),
        this.readCurrentBranch(worktreePath, worktreeGit),
      ]);
      if (stashList.total === 0) return false;
      return (await this.countOwnStashes(worktreeGit, stashList, currentBranch)) > 0;
    } catch (error) {
      this.logger.error(`Error checking stash`, error);
      return true;
    }
  }

  private async readCurrentBranch(worktreePath: string, git: SimpleGit): Promise<string | null | undefined> {
    try {
      const ref = (await this.runGit(() => git.raw(["symbolic-ref", "-q", "HEAD"]))).trim();
      if (ref.startsWith(GIT_CONSTANTS.REFS.HEADS)) return ref.slice(GIT_CONSTANTS.REFS.HEADS.length);
      if (ref) return undefined;
      return (await this.hasOperationInProgress(worktreePath)) ? undefined : null;
    } catch {
      return undefined;
    }
  }

  private listStashes(git: SimpleGit): Promise<StashListing> {
    return this.runGit(() =>
      git.stashList({ format: STASH_LIST_FORMAT } as unknown as Parameters<SimpleGit["stashList"]>[0]),
    );
  }

  private async countOwnStashes(
    git: SimpleGit,
    listing: StashListing,
    currentBranch: string | null | undefined,
  ): Promise<number> {
    const entries = (listing.all ?? []) as unknown as ReadonlyArray<Partial<StashEntry>>;
    const baseReachable = new Map<string, Promise<boolean>>();
    let count = 0;
    for (const entry of entries) {
      const branch = stashSubjectBranch(entry.subject ?? "");
      if (branch !== null) {
        if (currentBranch === undefined || branch === currentBranch) count++;
        continue;
      }
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

  private isInHeadHistory(git: SimpleGit, oid: string): Promise<boolean> {
    return this.runGit(() => git.raw(["rev-list", "--count", `HEAD..${oid}`])).then(
      (raw) => {
        const count = this.parseCount(raw);
        return count === null || count === 0;
      },
      () => true,
    );
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
      createGitClient(worktreePath, {
        ...this.config.extraEnv,
        ...(this.config.skipLfs ? { [ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE]: "1" } : {}),
      }),
    );
  }

  forgetWorktree(worktreePath: string): void {
    this.gitInstances.forget(worktreePath);
  }
}
