import { randomUUID } from "crypto";
import * as path from "path";

import pLimit from "p-limit";

import { DEFAULT_CONFIG, GIT_CONSTANTS } from "../constants";
import { PathResolutionService } from "../services/path-resolution.service";
import { filterBranchesByName } from "../utils/branch-filter";
import { isValidGitBranchName } from "../utils/git-validation";
import { pathsEqual } from "../utils/path-compare";

import { CapabilityUnavailableError, SyncInProgressError, formatToolResponse } from "./utils";

import type { Capabilities, DiscoveredRepoContext, RepositoryContext } from "./context";
import type { HandlerExtra } from "./utils";
import type { WorktreeStatusResult } from "../services/worktree-status.service";
import type { ProgressEvent } from "../services/worktree-sync.service";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type CapabilityKey = keyof Capabilities;
type RepoScopedParams = { repoName?: string };
type WorktreePathParams = RepoScopedParams & { path: string };
type RepoService = Awaited<ReturnType<RepositoryContext["getService"]>>;
type RepoGitService = ReturnType<RepoService["getGitService"]>;

const pathResolution = new PathResolutionService();

function ensureCapability(discovered: DiscoveredRepoContext | null, key: CapabilityKey, toolName: string): void {
  if (!discovered) return;
  if (!discovered.capabilities[key]) {
    throw new CapabilityUnavailableError(toolName, discovered.reasons);
  }
}

async function ensureNotSyncing(ctx: RepositoryContext, repoName?: string): Promise<void> {
  const entry = ctx.getEntry(repoName);
  if (!entry?.service) return;
  if (entry.service.isSyncInProgress()) {
    throw new SyncInProgressError(entry.name);
  }
}

async function getReadyService(
  ctx: RepositoryContext,
  repoName: string | undefined,
  options: {
    capability?: CapabilityKey;
    toolName?: string;
    ensureInitialized?: boolean;
    ensureNotSyncing?: boolean;
  } = {},
): Promise<{ discovered: DiscoveredRepoContext | null; service: RepoService; git: RepoGitService }> {
  const discovered = ctx.getDiscoveredContext(repoName);
  if (options.capability && options.toolName) {
    ensureCapability(discovered, options.capability, options.toolName);
  }
  if (options.ensureNotSyncing) {
    await ensureNotSyncing(ctx, repoName);
  }

  const service = await ctx.getService(repoName);
  if (options.ensureInitialized && !service.isInitialized()) {
    await service.initialize();
  }

  return {
    discovered,
    service,
    git: service.getGitService(),
  };
}

async function ensureRepoWorktreePath(
  ctx: RepositoryContext,
  params: WorktreePathParams,
  git: RepoGitService,
): Promise<string> {
  await ensurePathBelongsToRepo(ctx, params.path, params.repoName, git);
  return path.resolve(params.path);
}

async function ensurePathBelongsToRepo(
  ctx: RepositoryContext,
  targetPath: string,
  repoName: string | undefined,
  git: { getWorktrees: () => Promise<Array<{ path: string }>> },
): Promise<void> {
  const discovered = ctx.getDiscoveredContext(repoName);
  if (discovered?.allWorktrees.length) {
    const match = discovered.allWorktrees.some((w) => pathsEqual(w.path, targetPath));
    if (match) return;
  }

  try {
    const worktrees = await git.getWorktrees();
    if (worktrees.some((w) => pathsEqual(w.path, targetPath))) return;
  } catch {
    // fall through to rejection
  }

  throw new Error(`Path '${targetPath}' is not a registered worktree of the current repository`);
}

function deriveLabel(status: WorktreeStatusResult, isCurrent: boolean): string {
  if (isCurrent) return "current";
  if (!status.isClean || status.hasUnpushedCommits || status.hasStashedChanges) return "dirty";
  if (status.upstreamGone) return "stale";
  return "clean";
}

function formatLockError(lock: { locked: boolean; reason: string | null }, actionHint: string): string {
  const suffix = lock.reason ? ` (reason: ${lock.reason})` : "";
  return `Worktree is locked${suffix}. ${actionHint}`;
}

export async function handleDetectContext(
  ctx: RepositoryContext,
  params: { path?: string },
  _extra?: HandlerExtra,
): Promise<CallToolResult> {
  const target = params.path ?? process.cwd();
  const discovered = await ctx.detectFromPath(target);
  return formatToolResponse(discovered);
}

export async function handleListWorktrees(
  ctx: RepositoryContext,
  params: { repoName?: string; includePendingDetails?: boolean },
  _extra?: HandlerExtra,
): Promise<CallToolResult> {
  const { discovered, git } = await getReadyService(ctx, params.repoName, {
    capability: "canListWorktrees",
    toolName: "list_worktrees",
  });

  let worktrees: Array<{ path: string; branch: string }>;
  try {
    worktrees = await git.getWorktrees();
  } catch {
    if (discovered) {
      worktrees = discovered.allWorktrees.map((w) => ({ path: w.path, branch: w.branch }));
    } else {
      throw new Error("Cannot list worktrees - service not initialized and no detected context");
    }
  }

  const currentPath = discovered?.currentWorktreePath ?? null;
  const includeDetails = params.includePendingDetails ?? false;

  const limit = pLimit(DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS);
  const results = await Promise.all(
    worktrees.map((wt) =>
      limit(async () => {
        const resolvedPath = path.resolve(wt.path);
        const isCurrent = currentPath !== null && pathsEqual(wt.path, currentPath);

        const [status, divergence, metadata] = await Promise.all([
          git.getFullWorktreeStatus(wt.path, includeDetails).catch(() => null),
          git.getDivergenceFromWorktree(wt.path),
          git.getWorktreeMetadata(wt.path).catch(() => null),
        ]);

        const pendingWork = status && includeDetails ? buildPendingWork(status) : undefined;

        return {
          path: resolvedPath,
          branch: wt.branch,
          isCurrent,
          label: status ? deriveLabel(status, isCurrent) : "unknown",
          status,
          divergence,
          safeToRemove: status ? status.canRemove && !status.upstreamGone : false,
          lastSyncAt: metadata?.lastSyncDate ?? null,
          ...(pendingWork ? { pendingWork } : {}),
        };
      }),
    ),
  );

  return formatToolResponse({ worktrees: results });
}

function buildPendingWork(status: WorktreeStatusResult): {
  dirtyFiles: number;
  untrackedCount: number;
  unpushedCommits: number | null;
  stashes: number | null;
} {
  const d = status.details;
  const dirtyFiles =
    (d?.modifiedFiles ?? 0) +
    (d?.deletedFiles ?? 0) +
    (d?.renamedFiles ?? 0) +
    (d?.createdFiles ?? 0) +
    (d?.conflictedFiles ?? 0);
  return {
    dirtyFiles,
    untrackedCount: d?.untrackedFiles ?? 0,
    unpushedCommits: d?.unpushedCommitCount ?? (status.hasUnpushedCommits ? null : 0),
    stashes: d?.stashCount ?? (status.hasStashedChanges ? null : 0),
  };
}

export async function handleListBranches(
  ctx: RepositoryContext,
  params: { repoName?: string; scope?: "remote" | "local" | "both"; applyConfigFilters?: boolean },
  _extra?: HandlerExtra,
): Promise<CallToolResult> {
  const scope = params.scope ?? "both";
  const applyFilters = params.applyConfigFilters ?? true;

  const { service, git } = await getReadyService(ctx, params.repoName, {
    capability: "canListWorktrees",
    toolName: "list_branches",
    ensureInitialized: true,
  });

  const include = service.config.branchInclude;
  const exclude = service.config.branchExclude;
  const hasFilters = !!(include?.length || exclude?.length);

  const [remoteActivity, localBranches, worktrees] = await Promise.all([
    scope === "local" ? Promise.resolve([]) : git.getRemoteBranchesWithActivity().catch(() => []),
    scope === "remote" ? Promise.resolve([]) : git.getLocalBranches().catch(() => []),
    git.getWorktrees().catch(() => [] as Array<{ path: string; branch: string }>),
  ]);

  const worktreeBranches = new Set(worktrees.map((w) => w.branch));

  const filteredRemoteNames = hasFilters
    ? new Set(
        filterBranchesByName(
          remoteActivity.map((r) => r.branch),
          include,
          exclude,
        ),
      )
    : null;

  const remote = remoteActivity.map((r) => ({
    name: r.branch,
    lastActivity: r.lastActivity.toISOString(),
    hasWorktree: worktreeBranches.has(r.branch),
    matchesConfigFilter: filteredRemoteNames ? filteredRemoteNames.has(r.branch) : true,
  }));

  const filteredRemote = applyFilters && filteredRemoteNames ? remote.filter((r) => r.matchesConfigFilter) : remote;
  const branchesWithoutWorktrees = filteredRemote.filter((r) => !r.hasWorktree).map((r) => r.name);
  const branchesFilteredByConfig =
    applyFilters && filteredRemoteNames ? remote.filter((r) => !r.matchesConfigFilter).map((r) => r.name) : [];

  const local = localBranches.map((name) => ({
    name,
    hasWorktree: worktreeBranches.has(name),
  }));

  return formatToolResponse({
    remote,
    local,
    branchesWithoutWorktrees,
    branchesFilteredByConfig,
    configFiltersApplied: applyFilters && hasFilters,
  });
}

export async function handleGetWorktreeStatus(
  ctx: RepositoryContext,
  params: { path: string; repoName?: string; includeDetails?: boolean },
  _extra?: HandlerExtra,
): Promise<CallToolResult> {
  const { git } = await getReadyService(ctx, params.repoName, {
    capability: "canGetStatus",
    toolName: "get_worktree_status",
  });
  const resolvedPath = await ensureRepoWorktreePath(ctx, params, git);
  const [status, divergence] = await Promise.all([
    git.getFullWorktreeStatus(params.path, params.includeDetails ?? false),
    git.getDivergenceFromWorktree(params.path),
  ]);

  return formatToolResponse({
    path: resolvedPath,
    ...status,
    divergence,
  });
}

export type CompareBranchVerdict =
  | "safe-to-remove"
  | "would-lose-work"
  | "can-fast-forward"
  | "up-to-date"
  | "local-ahead"
  | "diverged-needs-review"
  | "no-upstream"
  | "no-local-branch";

export async function handleCompareBranch(
  ctx: RepositoryContext,
  params: { path?: string; branchName?: string; repoName?: string },
  _extra?: HandlerExtra,
): Promise<CallToolResult> {
  const hasPath = typeof params.path === "string" && params.path.length > 0;
  const hasBranch = typeof params.branchName === "string" && params.branchName.length > 0;
  if (!hasPath && !hasBranch) {
    throw new Error("Provide one of {path} or {branchName}");
  }
  if (hasPath && hasBranch) {
    throw new Error("Provide only one of {path} or {branchName}, not both");
  }

  const { git } = await getReadyService(ctx, params.repoName, {
    capability: "canGetStatus",
    toolName: "compare_branch",
    ensureInitialized: true,
  });

  if (hasPath) {
    return compareBranchByPath(ctx, params as { path: string; repoName?: string }, git);
  }
  return compareBranchByName(params.branchName!, git);
}

async function compareBranchByPath(
  ctx: RepositoryContext,
  params: { path: string; repoName?: string },
  git: RepoGitService,
): Promise<CallToolResult> {
  const resolvedPath = await ensureRepoWorktreePath(ctx, params, git);
  const worktrees = await git.getWorktrees();
  const wt = worktrees.find((w) => pathsEqual(w.path, params.path));
  if (!wt) {
    throw new Error(`Worktree not found at path '${params.path}'`);
  }
  const branchName = wt.branch;

  const [status, divergence, localCommit] = await Promise.all([
    git.getFullWorktreeStatus(params.path, false),
    git.getDivergenceFromWorktree(params.path),
    git.getCurrentCommit(params.path).catch(() => null),
  ]);

  let remoteCommit: string | null = null;
  let treeEqual = false;

  if (!status.upstreamGone) {
    [remoteCommit, treeEqual] = await Promise.all([
      git.getRemoteCommit(`${GIT_CONSTANTS.REMOTE_PREFIX}${branchName}`).catch(() => null),
      git.compareTreeContent(params.path, branchName).catch(() => false),
    ]);
  }

  const canFastForward = !!divergence && divergence.ahead === 0 && divergence.behind > 0;
  const localAhead = !!divergence && divergence.ahead > 0 && divergence.behind === 0;
  const hasDiverged = !!divergence && divergence.ahead > 0 && divergence.behind > 0;

  const reasons: string[] = [];
  let verdict: CompareBranchVerdict;

  if (!status.canRemove && (!status.isClean || status.hasOperationInProgress || status.hasModifiedSubmodules)) {
    verdict = "would-lose-work";
    reasons.push(...status.reasons);
  } else if (status.hasStashedChanges) {
    verdict = "would-lose-work";
    reasons.push("has stashed changes");
  } else if (status.upstreamGone) {
    verdict = "safe-to-remove";
    reasons.push("upstream branch deleted, no local work to preserve");
  } else if (treeEqual && (divergence === null || (divergence.ahead === 0 && divergence.behind === 0))) {
    verdict = "up-to-date";
  } else if (divergence && divergence.ahead === 0 && divergence.behind > 0 && canFastForward) {
    verdict = "can-fast-forward";
    reasons.push(`behind by ${divergence.behind} commits, fast-forward possible`);
  } else if (divergence && divergence.ahead > 0 && divergence.behind === 0 && localAhead) {
    verdict = "local-ahead";
    reasons.push(`ahead by ${divergence.ahead} commits, push needed`);
  } else if (status.hasUnpushedCommits) {
    verdict = "would-lose-work";
    reasons.push("has unpushed commits");
  } else if (hasDiverged) {
    verdict = "diverged-needs-review";
    if (divergence) reasons.push(`ahead ${divergence.ahead}, behind ${divergence.behind}`);
  } else if (divergence === null) {
    verdict = "diverged-needs-review";
    reasons.push("could not compute divergence");
  } else {
    verdict = "up-to-date";
  }

  return formatToolResponse({
    verdict,
    reasons,
    mode: "path",
    resolvedPath,
    branch: branchName,
    hasWorktree: true,
    hasLocalBranch: true,
    upstreamGone: status.upstreamGone,
    ahead: divergence?.ahead ?? null,
    behind: divergence?.behind ?? null,
    localCommit,
    remoteCommit,
    treeEqual,
    canFastForward,
    localAhead,
    hasDiverged,
  });
}

async function compareBranchByName(branchName: string, git: RepoGitService): Promise<CallToolResult> {
  const validation = isValidGitBranchName(branchName);
  if (!validation.valid) {
    throw new Error(`Invalid branch name '${branchName}': ${validation.error}`);
  }

  const [exists, worktrees] = await Promise.all([git.branchExists(branchName), git.getWorktrees()]);

  const hasWorktree = worktrees.some((w) => w.branch === branchName);
  const reasons: string[] = [];
  let verdict: CompareBranchVerdict;

  if (!exists.local && !exists.remote) {
    throw new Error(`Branch '${branchName}' not found locally or on origin`);
  }

  let localCommit: string | null = null;
  let remoteCommit: string | null = null;
  let divergence: { ahead: number; behind: number } | null = null;

  const [localRes, remoteRes, divergenceRes] = await Promise.all([
    exists.local ? git.getLocalCommit(branchName).catch(() => null) : Promise.resolve(null),
    exists.remote
      ? git.getRemoteCommit(`${GIT_CONSTANTS.REFS.REMOTES_ORIGIN_PREFIX}${branchName}`).catch(() => null)
      : Promise.resolve(null),
    exists.local && exists.remote ? git.getBranchDivergence(branchName) : Promise.resolve(null),
  ]);
  localCommit = localRes;
  remoteCommit = remoteRes;
  divergence = divergenceRes;

  if (!exists.local) {
    verdict = "no-local-branch";
    reasons.push("branch exists on origin but not locally");
  } else if (!exists.remote) {
    verdict = "no-upstream";
    reasons.push("local branch with no origin counterpart");
  } else if (localCommit && remoteCommit && localCommit === remoteCommit) {
    verdict = "up-to-date";
  } else if (divergence && divergence.ahead === 0 && divergence.behind === 0) {
    verdict = "up-to-date";
  } else if (divergence && divergence.ahead === 0 && divergence.behind > 0) {
    verdict = "can-fast-forward";
    reasons.push(`behind by ${divergence.behind} commits`);
  } else if (divergence && divergence.ahead > 0 && divergence.behind === 0) {
    verdict = "local-ahead";
    reasons.push(`ahead by ${divergence.ahead} commits`);
  } else if (divergence && divergence.ahead > 0 && divergence.behind > 0) {
    verdict = "diverged-needs-review";
    reasons.push(`ahead ${divergence.ahead}, behind ${divergence.behind}`);
  } else {
    verdict = "diverged-needs-review";
    reasons.push("could not compute divergence");
  }

  return formatToolResponse({
    verdict,
    reasons,
    mode: "branch",
    branch: branchName,
    hasWorktree,
    hasLocalBranch: exists.local,
    hasRemoteBranch: exists.remote,
    ahead: divergence?.ahead ?? null,
    behind: divergence?.behind ?? null,
    localCommit,
    remoteCommit,
  });
}

export async function handleCreateWorktree(
  ctx: RepositoryContext,
  params: { branchName: string; baseBranch?: string; push?: boolean; repoName?: string },
  extra?: HandlerExtra,
): Promise<CallToolResult> {
  const { branchName, baseBranch, push } = params;

  const validation = isValidGitBranchName(branchName);
  if (!validation.valid) {
    throw new Error(`Invalid branch name '${branchName}': ${validation.error}`);
  }

  const { service, git } = await getReadyService(ctx, params.repoName, {
    capability: "canCreateWorktree",
    toolName: "create_worktree",
    ensureInitialized: true,
    ensureNotSyncing: true,
  });

  const reporter = attachProgressReporter(service, extra, { scoped: true });
  try {
    reporter.emit({ phase: "create", message: `Resolving branch '${branchName}'` });
    const existence = await git.branchExists(branchName);

    let created = false;
    let pushed = false;

    if (!existence.local && !existence.remote) {
      if (!baseBranch) {
        throw new Error(`Branch '${branchName}' does not exist. Provide 'baseBranch' to create it.`);
      }
      reporter.emit({ phase: "create", message: `Creating branch '${branchName}' from '${baseBranch}'` });
      await git.createBranch(branchName, baseBranch);
      created = true;
    }

    const worktreeDir = service.config.worktreeDir;
    const worktreePath = pathResolution.getBranchWorktreePath(worktreeDir, branchName);
    const existing = await git.getWorktrees();
    const collision = existing.find((w) => pathsEqual(w.path, worktreePath) && w.branch !== branchName);
    if (collision) {
      throw new Error(
        `Sanitized worktree path '${worktreePath}' collides with existing branch '${collision.branch}'. Rename or remove the conflicting branch first.`,
      );
    }
    reporter.emit({ phase: "create", message: `Adding worktree at '${worktreePath}'` });
    await git.addWorktree(branchName, worktreePath);
    ctx.invalidateDiscovered();

    if (created && push) {
      reporter.emit({ phase: "push", message: `Pushing '${branchName}' to origin` });
      await git.pushBranch(branchName);
      pushed = true;
    }

    reporter.emit({ phase: "create", message: `Worktree ready at '${worktreePath}'` });
    return formatToolResponse({
      success: true,
      branchName,
      worktreePath: path.resolve(worktreePath),
      created,
      pushed,
    });
  } finally {
    reporter.dispose();
  }
}

export async function handleRemoveWorktree(
  ctx: RepositoryContext,
  params: { path: string; force?: boolean; repoName?: string },
  extra?: HandlerExtra,
): Promise<CallToolResult> {
  const { service, git } = await getReadyService(ctx, params.repoName, {
    capability: "canRemoveWorktree",
    toolName: "remove_worktree",
    ensureInitialized: true,
    ensureNotSyncing: true,
  });
  const removedPath = await ensureRepoWorktreePath(ctx, params, git);

  const reporter = attachProgressReporter(service, extra, { scoped: true });
  try {
    if (!params.force) {
      reporter.emit({ phase: "remove", message: `Validating safety for '${params.path}'` });
      const lock = await git.isWorktreeLocked(params.path);
      if (lock.locked) {
        throw new Error(formatLockError(lock, "Unlock with 'git worktree unlock' or pass force=true to override."));
      }
      const status = await git.getFullWorktreeStatus(params.path, false);
      if (!status.canRemove) {
        throw new Error(`Cannot remove worktree: ${status.reasons.join(", ")}. Use force=true to override.`);
      }
    }

    reporter.emit({ phase: "remove", message: `Removing worktree '${params.path}'` });
    await git.removeWorktree(params.path, params.force ?? false);
    ctx.invalidateDiscovered();
    reporter.emit({ phase: "remove", message: `Worktree '${params.path}' removed` });

    return formatToolResponse({
      success: true,
      removedPath,
    });
  } finally {
    reporter.dispose();
  }
}

export async function handleSync(
  ctx: RepositoryContext,
  params: { repoName?: string },
  extra?: HandlerExtra,
): Promise<CallToolResult> {
  const { service } = await getReadyService(ctx, params.repoName, {
    capability: "canSync",
    toolName: "sync",
    ensureInitialized: true,
  });

  const reporter = attachProgressReporter(service, extra);
  try {
    const start = Date.now();
    const result = await service.sync();
    if (!result.started) {
      throw new SyncInProgressError(ctx.getEntry(params.repoName)?.name ?? params.repoName ?? "unknown");
    }
    const duration = Date.now() - start;
    ctx.invalidateDiscovered();
    return formatToolResponse({ success: true, duration });
  } finally {
    reporter.dispose();
  }
}

export async function handleUpdateWorktree(
  ctx: RepositoryContext,
  params: { path: string; repoName?: string },
  extra?: HandlerExtra,
): Promise<CallToolResult> {
  const { service, git } = await getReadyService(ctx, params.repoName, {
    capability: "canUpdateWorktree",
    toolName: "update_worktree",
    ensureInitialized: true,
    ensureNotSyncing: true,
  });
  const worktreePath = await ensureRepoWorktreePath(ctx, params, git);

  const reporter = attachProgressReporter(service, extra, { scoped: true });
  try {
    reporter.emit({ phase: "update", message: `Checking lock state for '${params.path}'` });
    const lock = await git.isWorktreeLocked(params.path);
    if (lock.locked) {
      throw new Error(formatLockError(lock, "Unlock with 'git worktree unlock' before updating."));
    }

    reporter.emit({ phase: "update", message: `Fast-forwarding '${params.path}'` });
    await git.updateWorktree(params.path);
    ctx.invalidateDiscovered();
    reporter.emit({ phase: "update", message: `Worktree '${params.path}' updated` });

    return formatToolResponse({
      success: true,
      worktreePath,
    });
  } finally {
    reporter.dispose();
  }
}

export async function handleInitialize(
  ctx: RepositoryContext,
  params: { repoName?: string },
  extra?: HandlerExtra,
): Promise<CallToolResult> {
  const { service } = await getReadyService(ctx, params.repoName, {
    capability: "canInitialize",
    toolName: "initialize",
    ensureNotSyncing: true,
  });
  const reporter = attachProgressReporter(service, extra);
  try {
    await service.initialize();
    const git = service.getGitService();
    ctx.invalidateDiscovered();
    return formatToolResponse({
      success: true,
      defaultBranch: git.getDefaultBranch(),
      worktreeDir: service.config.worktreeDir,
    });
  } finally {
    reporter.dispose();
  }
}

export async function handleLoadConfig(
  ctx: RepositoryContext,
  params: { configPath?: string },
  _extra?: HandlerExtra,
): Promise<CallToolResult> {
  const configPath = params.configPath ?? process.env.SYNC_WORKTREES_CONFIG;
  if (!configPath) {
    throw new Error("configPath required (or set SYNC_WORKTREES_CONFIG env var)");
  }
  await ctx.loadConfig(configPath);
  return formatToolResponse({
    configPath: path.resolve(configPath),
    currentRepository: ctx.getCurrentRepo(),
    repositories: ctx.getRepositoryList(),
  });
}

export async function handleSetCurrentRepository(
  ctx: RepositoryContext,
  params: { repoName: string },
  _extra?: HandlerExtra,
): Promise<CallToolResult> {
  ctx.setCurrentRepo(params.repoName);
  return formatToolResponse({
    currentRepository: ctx.getCurrentRepo(),
    repositories: ctx.getRepositoryList(),
  });
}

interface ProgressReporter {
  dispose: () => void;
  emit: (event: ProgressEvent) => void;
  correlationId: string;
}

function attachProgressReporter(
  service: {
    onProgress?: (listener: (event: ProgressEvent) => void) => () => void;
  },
  extra: HandlerExtra | undefined,
  options: { scoped?: boolean } = {},
): ProgressReporter {
  const correlationId = randomUUID();
  const token = extra?._meta?.progressToken;
  const noop: ProgressReporter = { dispose: () => {}, emit: () => {}, correlationId };

  if (token === undefined || !extra) return noop;

  let progressCounter = 0;
  const send = (event: ProgressEvent): void => {
    progressCounter++;
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress: progressCounter,
          message: `[${event.phase}] ${event.message}`,
        },
      })
      .catch(() => {});
  };

  const scoped = options.scoped ?? false;
  let dispose: () => void = () => {};
  if (service.onProgress) {
    dispose = service.onProgress((event) => {
      if (scoped && event.correlationId !== correlationId) return;
      send(event);
    });
  }

  return {
    dispose,
    emit: (event) => send({ ...event, correlationId }),
    correlationId,
  };
}
