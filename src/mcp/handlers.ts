import * as path from "path";

import pLimit from "p-limit";

import { DEFAULT_CONFIG } from "../constants";
import { PathResolutionService } from "../services/path-resolution.service";
import { WorktreeStatusService } from "../services/worktree-status.service";
import { formatCloneSkipReason } from "../utils/clone-skip-format";
import { calculateDirectorySize } from "../utils/disk-space";
import { isValidGitBranchName } from "../utils/git-validation";
import { pathsEqual } from "../utils/path-compare";

import { CapabilityUnavailableError, SyncInProgressError, formatToolResponse } from "./utils";
import { deriveLabel, deriveSafeToRemove, getDivergence } from "./worktree-summary";

import type { Capabilities, DiscoveredRepoContext, DiscoveredWorktree, RepositoryContext } from "./context";
import type { HandlerExtra } from "./utils";
import type { WorktreeLabel } from "./worktree-summary";
import type { ProgressEvent } from "../services/worktree-sync.service";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type CapabilityKey = keyof Capabilities;
type RepoScopedParams = { repoName?: string };
type WorktreePathParams = RepoScopedParams & { path: string };
type RepoService = Awaited<ReturnType<RepositoryContext["getService"]>>;
type RepoGitService = ReturnType<RepoService["getGitService"]>;
type Limit = ReturnType<typeof pLimit>;
type ListedWorktree = {
  path: string;
  branch: string;
  isCurrent: boolean;
  label: WorktreeLabel;
  status: Awaited<ReturnType<RepoGitService["getFullWorktreeStatus"]>> | null;
  divergence: Awaited<ReturnType<typeof getDivergence>>;
  safeToRemove: ReturnType<typeof deriveSafeToRemove>;
  lastSyncAt: string | null;
  sizeBytes: number | null;
};

const pathResolution = new PathResolutionService();
const CLONE_MODE_WORKTREE_MUTATION_REASON =
  "clone-mode repositories have a single checkout; use sync for clone-mode updates";

function ensureCapability(discovered: DiscoveredRepoContext | null, key: CapabilityKey, toolName: string): void {
  if (!discovered) return;
  const cap = discovered.capabilities[key];
  if (!cap.available) {
    const reasons = cap.reason ? [cap.reason] : discovered.notes;
    throw new CapabilityUnavailableError(toolName, reasons);
  }
}

async function getReadyService(
  ctx: RepositoryContext,
  repoName: string | undefined,
  options: {
    capability?: CapabilityKey;
    toolName?: string;
    ensureInitialized?: boolean;
  } = {},
): Promise<{ discovered: DiscoveredRepoContext | null; service: RepoService; git: RepoGitService }> {
  const discovered = ctx.getDiscoveredContext(repoName);
  if (options.capability && options.toolName) {
    ensureCapability(discovered, options.capability, options.toolName);
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

async function runExclusiveRepoOperation<T>(
  ctx: RepositoryContext,
  repoName: string | undefined,
  service: RepoService,
  operation: () => Promise<T>,
): Promise<T> {
  const result = await service.runExclusiveRepoOperation(operation);
  if (!result.started) {
    const name = ctx.getEntry(repoName)?.name ?? repoName ?? "unknown";
    throw new SyncInProgressError(name);
  }
  return result.value;
}

async function ensureRepoWorktreePath(
  ctx: RepositoryContext,
  params: WorktreePathParams,
  service: RepoService,
  git: RepoGitService,
): Promise<string> {
  await ensurePathBelongsToRepo(ctx, params.path, params.repoName, service, git);
  return path.resolve(params.path);
}

async function ensurePathBelongsToRepo(
  ctx: RepositoryContext,
  targetPath: string,
  repoName: string | undefined,
  service: RepoService,
  git: RepoGitService,
): Promise<void> {
  const discovered = ctx.getDiscoveredContext(repoName);
  if (discovered?.allWorktrees.length) {
    const match = discovered.allWorktrees.some((w) => pathsEqual(w.path, targetPath));
    if (match) return;
  }

  try {
    const worktrees = await getWorktreesFromService(service, git);
    if (worktrees.some((w) => pathsEqual(w.path, targetPath))) return;
  } catch {
    // fall through to rejection
  }

  throw new Error(`Path '${targetPath}' is not a registered worktree of the current repository`);
}

function isCloneModeService(service: RepoService): boolean {
  const candidate = service as RepoService & { isCloneMode?: () => boolean };
  return typeof candidate.isCloneMode === "function" && candidate.isCloneMode();
}

function ensureWorktreeModeService(service: RepoService, toolName: string): void {
  if (isCloneModeService(service)) {
    throw new CapabilityUnavailableError(toolName, [CLONE_MODE_WORKTREE_MUTATION_REASON]);
  }
}

async function getWorktreesFromService(
  service: RepoService,
  git: { getWorktrees: () => Promise<Array<{ path: string; branch: string }>> },
): Promise<Array<{ path: string; branch: string }>> {
  const candidate = service as RepoService & {
    getWorktrees?: () => Promise<Array<{ path: string; branch: string }>>;
  };
  if (typeof candidate.getWorktrees === "function") {
    return candidate.getWorktrees();
  }
  return git.getWorktrees();
}

export async function handleDetectContext(
  ctx: RepositoryContext,
  params: { path?: string; includeStatus?: boolean; includeAllWorktrees?: boolean },
  _extra?: HandlerExtra,
): Promise<CallToolResult> {
  const target = params.path ?? process.cwd();
  const discovered = await ctx.detectFromPath(target);
  let response: DiscoveredRepoContext = discovered;

  if (params.includeAllWorktrees) {
    const details = await ctx.getAllConfiguredWorktreeDetails(discovered.currentWorktreePath);
    const errorsByRepo = Object.keys(details.errorsByRepo).length > 0 ? details.errorsByRepo : undefined;
    response = {
      ...response,
      allWorktreesByRepo: details.worktreesByRepo,
      allWorktreeErrorsByRepo: errorsByRepo,
    };
  }

  if (!params.includeStatus) {
    return formatToolResponse(response);
  }

  const statusService = new WorktreeStatusService();
  const statusLimit = pLimit(DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS);

  const enriched = await enrichDetectedWorktrees(response.allWorktrees, statusService, statusLimit);
  let allWorktreesByRepo = response.allWorktreesByRepo;

  if (allWorktreesByRepo) {
    const entries = await Promise.all(
      Object.entries(allWorktreesByRepo).map(async ([repoName, worktrees]) => [
        repoName,
        await enrichDetectedWorktrees(worktrees, statusService, statusLimit),
      ]),
    );
    allWorktreesByRepo = Object.fromEntries(entries);
  }

  return formatToolResponse({ ...response, allWorktrees: enriched, allWorktreesByRepo });
}

async function enrichDetectedWorktrees(
  worktrees: DiscoveredWorktree[],
  statusService: WorktreeStatusService,
  limit: Limit,
): Promise<DiscoveredWorktree[]> {
  if (worktrees.length === 0) return worktrees;

  return Promise.all(
    worktrees.map((wt) =>
      limit(async () => {
        const [status, divergence] = await Promise.all([
          statusService.getFullWorktreeStatus(wt.path, false).catch(() => null),
          getDivergence(wt.path),
        ]);
        return {
          ...wt,
          label: status
            ? deriveLabel(status, wt.isCurrent)
            : wt.isCurrent
              ? ("current" as const)
              : ("unknown" as const),
          divergence,
          staleHint: status?.upstreamGone ?? false,
        };
      }),
    ),
  );
}

export async function handleListWorktrees(
  ctx: RepositoryContext,
  params: { repoName?: string; includeSize?: boolean },
  _extra?: HandlerExtra,
): Promise<CallToolResult> {
  const configuredRepoNames = params.repoName ? [] : ctx.getConfiguredRepositoryNames();
  if (configuredRepoNames.length > 0) {
    const limit = pLimit(DEFAULT_CONFIG.PARALLELISM.MAX_REPOSITORIES);
    const statusLimit = pLimit(DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS);
    const repositories = await Promise.all(
      configuredRepoNames.map((repoName) =>
        limit(async () => {
          try {
            return [
              repoName,
              {
                worktrees: await listWorktreesForRepo(ctx, repoName, params.includeSize, statusLimit),
              },
            ] as const;
          } catch (err) {
            return [
              repoName,
              {
                worktrees: [],
                error: err instanceof Error ? err.message : String(err),
              },
            ] as const;
          }
        }),
      ),
    );

    return formatToolResponse({ repositories: Object.fromEntries(repositories) });
  }

  const results = await listWorktreesForRepo(ctx, params.repoName, params.includeSize);
  return formatToolResponse({ worktrees: results });
}

async function listWorktreesForRepo(
  ctx: RepositoryContext,
  repoName: string | undefined,
  includeSize: boolean | undefined,
  limit: Limit = pLimit(DEFAULT_CONFIG.PARALLELISM.MAX_STATUS_CHECKS),
): Promise<ListedWorktree[]> {
  const { discovered, service, git } = await getReadyService(ctx, repoName, {
    capability: "listWorktrees",
    toolName: "list_worktrees",
  });

  let worktrees: Array<{ path: string; branch: string }>;
  try {
    worktrees = await getWorktreesFromService(service, git);
  } catch {
    if (discovered) {
      worktrees = discovered.allWorktrees.map((w) => ({ path: w.path, branch: w.branch }));
    } else {
      throw new Error("Cannot list worktrees - service not initialized and no detected context");
    }
  }

  const currentPath = discovered?.currentWorktreePath ?? null;

  const results = await Promise.all(
    worktrees.map((wt) =>
      limit(async () => {
        const resolvedPath = path.resolve(wt.path);
        const isCurrent = currentPath !== null && pathsEqual(wt.path, currentPath);

        const [status, divergence, metadata, sizeBytes] = await Promise.all([
          git.getFullWorktreeStatus(wt.path, false).catch(() => null),
          getDivergence(wt.path),
          git.getWorktreeMetadata(wt.path).catch(() => null),
          includeSize ? calculateDirectorySize(wt.path).catch(() => null) : Promise.resolve(null),
        ]);

        return {
          path: resolvedPath,
          branch: wt.branch,
          isCurrent,
          label: status ? deriveLabel(status, isCurrent) : isCurrent ? "current" : "unknown",
          status,
          divergence,
          safeToRemove: status ? deriveSafeToRemove(status) : { safe: false, reason: "status unavailable" },
          lastSyncAt: metadata?.lastSyncDate ?? null,
          sizeBytes,
        };
      }),
    ),
  );

  return results;
}

export async function handleGetWorktreeStatus(
  ctx: RepositoryContext,
  params: { path: string; repoName?: string; includeDetails?: boolean },
  _extra?: HandlerExtra,
): Promise<CallToolResult> {
  const { service, git } = await getReadyService(ctx, params.repoName, {
    capability: "getStatus",
    toolName: "get_worktree_status",
  });
  const resolvedPath = await ensureRepoWorktreePath(ctx, params, service, git);
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
  const { branchName, baseBranch } = params;
  const push = params.push ?? true;

  const validation = isValidGitBranchName(branchName);
  if (!validation.valid) {
    throw new Error(`Invalid branch name '${branchName}': ${validation.error}`);
  }

  const { service, git } = await getReadyService(ctx, params.repoName, {
    capability: "createWorktree",
    toolName: "create_worktree",
  });
  ensureWorktreeModeService(service, "create_worktree");

  return runExclusiveRepoOperation(ctx, params.repoName, service, async () => {
    if (!service.isInitialized()) {
      await service.initializeUnlocked();
    }

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
    const worktreePath = pathResolution.getBranchWorktreePath(worktreeDir, branchName);
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
  });
}

export async function handleRemoveWorktree(
  ctx: RepositoryContext,
  params: { path: string; force?: boolean; repoName?: string },
  _extra?: HandlerExtra,
): Promise<CallToolResult> {
  const { service, git } = await getReadyService(ctx, params.repoName, {
    capability: "removeWorktree",
    toolName: "remove_worktree",
  });
  ensureWorktreeModeService(service, "remove_worktree");

  return runExclusiveRepoOperation(ctx, params.repoName, service, async () => {
    if (!service.isInitialized()) {
      await service.initializeUnlocked();
    }
    const removedPath = await ensureRepoWorktreePath(ctx, params, service, git);

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
  });
}

export async function handleSync(
  ctx: RepositoryContext,
  params: { repoName?: string },
  extra?: HandlerExtra,
): Promise<CallToolResult> {
  const { service } = await getReadyService(ctx, params.repoName, {
    capability: "sync",
    toolName: "sync",
  });

  const dispose = attachProgressReporter(service, extra);
  try {
    const start = Date.now();
    service.clearRecordedSkips();
    const result = await service.sync();
    if (!result.started) {
      throw new SyncInProgressError(ctx.getEntry(params.repoName)?.name ?? params.repoName ?? "unknown");
    }
    const duration = Date.now() - start;
    ctx.invalidateDiscovered();
    const skips = service.getRecordedSkips().map((reason) => ({
      ...reason,
      message: formatCloneSkipReason(reason),
    }));
    return formatToolResponse({ success: true, duration, skips });
  } finally {
    dispose();
  }
}

export async function handleUpdateWorktree(
  ctx: RepositoryContext,
  params: { path: string; repoName?: string },
  _extra?: HandlerExtra,
): Promise<CallToolResult> {
  const { service, git } = await getReadyService(ctx, params.repoName, {
    capability: "updateWorktree",
    toolName: "update_worktree",
  });
  ensureWorktreeModeService(service, "update_worktree");

  return runExclusiveRepoOperation(ctx, params.repoName, service, async () => {
    if (!service.isInitialized()) {
      await service.initializeUnlocked();
    }
    const worktreePath = await ensureRepoWorktreePath(ctx, params, service, git);

    await git.updateWorktree(params.path);
    ctx.invalidateDiscovered();

    return formatToolResponse({
      success: true,
      worktreePath,
    });
  });
}

export async function handleInitialize(
  ctx: RepositoryContext,
  params: { repoName?: string },
  extra?: HandlerExtra,
): Promise<CallToolResult> {
  const { service } = await getReadyService(ctx, params.repoName, {
    capability: "initialize",
    toolName: "initialize",
  });
  const dispose = attachProgressReporter(service, extra);
  try {
    return await runExclusiveRepoOperation(ctx, params.repoName, service, async () => {
      await service.initializeUnlocked();
      const git = service.getGitService();
      ctx.invalidateDiscovered();
      return formatToolResponse({
        success: true,
        defaultBranch: git.getDefaultBranch(),
        worktreeDir: service.config.worktreeDir,
      });
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
