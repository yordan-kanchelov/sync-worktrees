import * as path from "path";

import pLimit from "p-limit";
import simpleGit from "simple-git";

import { DEFAULT_CONFIG } from "../constants";
import { PathResolutionService } from "../services/path-resolution.service";
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

async function getDivergence(worktreePath: string): Promise<{ ahead: number; behind: number } | null> {
  try {
    const git = simpleGit(worktreePath);
    const output = await git.raw(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    const [aheadStr, behindStr] = output.trim().split(/\s+/);
    return { ahead: parseInt(aheadStr, 10), behind: parseInt(behindStr, 10) };
  } catch {
    return null;
  }
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
  params: { repoName?: string },
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

  const limit = pLimit(DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS);
  const results = await Promise.all(
    worktrees.map((wt) =>
      limit(async () => {
        const resolvedPath = path.resolve(wt.path);
        const isCurrent = currentPath !== null && pathsEqual(wt.path, currentPath);

        const [status, divergence, metadata] = await Promise.all([
          git.getFullWorktreeStatus(wt.path, false).catch(() => null),
          getDivergence(wt.path),
          git.getWorktreeMetadata(wt.path).catch(() => null),
        ]);

        return {
          path: resolvedPath,
          branch: wt.branch,
          isCurrent,
          label: status ? deriveLabel(status, isCurrent) : "unknown",
          status,
          divergence,
          safeToRemove: status ? status.canRemove && !status.upstreamGone : false,
          lastSyncAt: metadata?.lastSyncDate ?? null,
        };
      }),
    ),
  );

  return formatToolResponse({ worktrees: results });
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
    getDivergence(params.path),
  ]);

  return formatToolResponse({
    path: resolvedPath,
    ...status,
    divergence,
  });
}

export async function handleCreateWorktree(
  ctx: RepositoryContext,
  params: { branchName: string; baseBranch?: string; push?: boolean; repoName?: string },
  _extra?: HandlerExtra,
): Promise<CallToolResult> {
  const { service, git } = await getReadyService(ctx, params.repoName, {
    capability: "canCreateWorktree",
    toolName: "create_worktree",
    ensureInitialized: true,
    ensureNotSyncing: true,
  });

  const { branchName, baseBranch, push } = params;
  const existence = await git.branchExists(branchName);

  let created = false;
  let pushed = false;

  if (!existence.local && !existence.remote) {
    if (!baseBranch) {
      throw new Error(`Branch '${branchName}' does not exist. Provide 'baseBranch' to create it.`);
    }
    await git.createBranch(branchName, baseBranch);
    created = true;
  }

  const worktreeDir = service.config.worktreeDir;
  const worktreePath = new PathResolutionService().getBranchWorktreePath(worktreeDir, branchName);
  const existing = await git.getWorktrees();
  const collision = existing.find((w) => pathsEqual(w.path, worktreePath) && w.branch !== branchName);
  if (collision) {
    throw new Error(
      `Sanitized worktree path '${worktreePath}' collides with existing branch '${collision.branch}'. Rename or remove the conflicting branch first.`,
    );
  }
  await git.addWorktree(branchName, worktreePath);
  ctx.invalidateDiscovered();

  if (created && push) {
    await git.pushBranch(branchName);
    pushed = true;
  }

  return formatToolResponse({
    success: true,
    branchName,
    worktreePath: path.resolve(worktreePath),
    created,
    pushed,
  });
}

export async function handleRemoveWorktree(
  ctx: RepositoryContext,
  params: { path: string; force?: boolean; repoName?: string },
  _extra?: HandlerExtra,
): Promise<CallToolResult> {
  const { git } = await getReadyService(ctx, params.repoName, {
    capability: "canRemoveWorktree",
    toolName: "remove_worktree",
    ensureInitialized: true,
    ensureNotSyncing: true,
  });
  const removedPath = await ensureRepoWorktreePath(ctx, params, git);

  if (!params.force) {
    const status = await git.getFullWorktreeStatus(params.path, false);
    if (!status.canRemove) {
      throw new Error(`Cannot remove worktree: ${status.reasons.join(", ")}. Use force=true to override.`);
    }
  }

  await git.removeWorktree(params.path);
  ctx.invalidateDiscovered();

  return formatToolResponse({
    success: true,
    removedPath,
  });
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

  const dispose = attachProgressReporter(service, extra);
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
    dispose();
  }
}

export async function handleUpdateWorktree(
  ctx: RepositoryContext,
  params: { path: string; repoName?: string },
  _extra?: HandlerExtra,
): Promise<CallToolResult> {
  const { git } = await getReadyService(ctx, params.repoName, {
    capability: "canUpdateWorktree",
    toolName: "update_worktree",
    ensureInitialized: true,
    ensureNotSyncing: true,
  });
  const worktreePath = await ensureRepoWorktreePath(ctx, params, git);

  await git.updateWorktree(params.path);
  ctx.invalidateDiscovered();

  return formatToolResponse({
    success: true,
    worktreePath,
  });
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
  const dispose = attachProgressReporter(service, extra);
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
    dispose();
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

function attachProgressReporter(
  service: {
    onProgress?: (listener: (event: ProgressEvent) => void) => () => void;
  },
  extra: HandlerExtra | undefined,
): () => void {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra) return () => {};
  if (!service.onProgress) return () => {};

  let progressCounter = 0;
  const unsubscribe = service.onProgress((event) => {
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
  });

  return unsubscribe;
}
