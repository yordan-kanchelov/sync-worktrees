import { getErrorMessage } from "../../utils/errors";
import { isLfsError, isMissingRemoteRefError } from "../../utils/lfs-error";

import { getBranchRefspec, isShallowRepository } from "./git-helpers";

import type { RemoteRelationship } from "../git.service";
import type { MutatingGitClients } from "./git-clients";
import type { CloneSyncContext } from "./types";
import type { SimpleGit } from "simple-git";

const SHALLOW_RELATION_DEEPEN_TARGETS = [50, 200, 1000] as const;

export function describeDeepenAttempt(deepenedTo: number | null): string {
  return deepenedTo === null
    ? "no deepening attempted (configured depth already at or above all deepen targets)"
    : `deepening to ${deepenedTo} commits`;
}

export async function buildSyncFetchArgs(ctx: CloneSyncContext, git: SimpleGit, branch: string): Promise<string[]> {
  const args = ["origin", "--prune", "--no-tags", "--progress"];
  const depth = await resolveSyncFetchDepth(ctx, git, branch);
  if (depth !== null) {
    args.push("--depth", String(depth));
  }
  args.push(getBranchRefspec(branch));
  return args;
}

async function resolveSyncFetchDepth(ctx: CloneSyncContext, git: SimpleGit, branch: string): Promise<number | null> {
  const configuredDepth = ctx.config.depth;
  if (configuredDepth === undefined) return null;
  if (!(await isShallowRepository(git))) return null;
  const localDepth =
    (await measureLocalHistoryDepth(git, `refs/remotes/origin/${branch}`)) ??
    (await measureLocalHistoryDepth(git, "HEAD"));
  if (localDepth === null) return configuredDepth;
  return Math.max(configuredDepth, localDepth);
}

async function measureLocalHistoryDepth(git: SimpleGit, startRef: string): Promise<number | null> {
  return (await walkLocalHistory(git, startRef))?.depth ?? null;
}

async function walkLocalHistory(
  git: SimpleGit,
  startRef: string,
): Promise<{ depth: number; parentless: string[] } | null> {
  let output: string;
  try {
    output = await git.raw(["rev-list", "--topo-order", "--parents", startRef]);
  } catch {
    return null;
  }
  if (typeof output !== "string") return null;

  const depthByCommit = new Map<string, number>();
  const parentless: string[] = [];
  let deepest = -1;
  for (const line of output.split("\n")) {
    const ids = line.trim().split(" ");
    const commit = ids[0];
    if (!commit) continue;
    const depth = depthByCommit.get(commit) ?? 0;
    if (depth > deepest) deepest = depth;
    if (ids.length === 1) parentless.push(commit);
    for (let i = 1; i < ids.length; i++) {
      const parent = ids[i];
      const known = depthByCommit.get(parent);
      if (known === undefined || known > depth + 1) depthByCommit.set(parent, depth + 1);
    }
  }
  return deepest < 0 ? null : { depth: deepest + 1, parentless };
}

async function measureDeepenWindow(git: SimpleGit, branch: string): Promise<number | null> {
  const walk = await walkLocalHistory(git, `refs/remotes/origin/${branch}`);
  if (!walk) return null;
  for (const commit of walk.parentless) {
    try {
      const object = await git.raw(["cat-file", "commit", commit]);
      if (typeof object !== "string" || /^parent /m.test(object)) return walk.depth;
    } catch {
      return walk.depth;
    }
  }
  return Infinity;
}

export async function buildUntrackedBranchFetchArgs(
  ctx: CloneSyncContext,
  git: SimpleGit,
  branch: string,
): Promise<string[]> {
  const args = ["origin", "--prune", "--no-tags", "--progress"];
  if (ctx.config.depth !== undefined && (await isShallowRepository(git))) {
    args.push("--depth", String(ctx.config.depth));
  }
  args.push(getBranchRefspec(branch));
  return args;
}

export function recordMissingRemoteRefSkip(ctx: CloneSyncContext, branch: string): void {
  ctx.recordSkip(
    { kind: "missing_remote_ref", branch, source: "fetch_error" },
    `Tracked branch '${branch}' is missing on remote for '${ctx.repoName}'. Skipping sync.`,
    `Skipping '${ctx.repoName}': origin/${branch} is missing`,
  );
}

export async function fetchWithRecovery(
  ctx: CloneSyncContext,
  clients: MutatingGitClients,
  fetchArgs: string[],
  worktreeDir: string,
  branch: string,
  recordSkip = true,
): Promise<{ skipped: boolean }> {
  const recordMissing = (): void => {
    if (recordSkip) recordMissingRemoteRefSkip(ctx, branch);
  };
  try {
    await clients.networkGit.fetch(fetchArgs);
    return { skipped: false };
  } catch (fetchError) {
    const message = getErrorMessage(fetchError);
    if (isLfsError(message)) {
      ctx.logger.info(`⚠️  LFS error during fetch for '${ctx.repoName}'; retrying with LFS disabled.`);
      ctx.emitProgress({ phase: "fetch", message: `Retrying fetch for '${ctx.repoName}' with LFS disabled` });
      const lfsSkipGit = ctx.clients.lfsSkipFetchClient(clients, worktreeDir);
      try {
        await lfsSkipGit.fetch(fetchArgs);
        return { skipped: false };
      } catch (retryError) {
        if (isMissingRemoteRefError(getErrorMessage(retryError))) {
          recordMissing();
          return { skipped: true };
        }
        throw retryError;
      }
    }
    if (isMissingRemoteRefError(message)) {
      recordMissing();
      return { skipped: true };
    }
    throw fetchError;
  }
}

export async function unshallowIfDepthRemoved(ctx: CloneSyncContext, clients: MutatingGitClients): Promise<void> {
  if (ctx.config.depth !== undefined) return;

  if (!(await isShallowRepository(clients.git))) return;

  ctx.logger.info(
    `[deepen] Existing shallow clone for '${ctx.repoName}' has no configured depth; fetching full history...`,
  );
  ctx.emitProgress({ phase: "fetch", message: `Fetching full history for '${ctx.repoName}'` });
  await clients.unshallowGit.fetch(["--unshallow", "--no-tags", "--progress"]);
}

export function getDeepenTargets(ctx: CloneSyncContext): readonly number[] {
  const configuredDepth = ctx.config.depth;
  if (configuredDepth === undefined) return [];
  return SHALLOW_RELATION_DEEPEN_TARGETS.filter((target) => target > configuredDepth);
}

async function deepenShallowHistoryToDepth(
  ctx: CloneSyncContext,
  clients: MutatingGitClients,
  branch: string,
  targetDepth: number,
): Promise<void> {
  ctx.logger.info(
    `[deepen] Shallow clone for '${ctx.repoName}' lacks enough history to classify origin/${branch}; ` +
      `refetching to depth ${targetDepth} before deciding.`,
  );
  ctx.emitProgress({
    phase: "fetch",
    message: `Deepening '${ctx.repoName}' to depth ${targetDepth} before classifying origin/${branch}`,
  });
  await clients.networkGit.fetch([
    "origin",
    "--depth",
    String(targetDepth),
    "--prune",
    "--no-tags",
    "--progress",
    getBranchRefspec(branch),
  ]);
}

export async function classifyWithDeepening(
  ctx: CloneSyncContext,
  clients: MutatingGitClients,
  worktreeDir: string,
  branch: string,
  localRef?: string,
): Promise<{ relationship: RemoteRelationship; deepenedTo: number | null; deepenFetches: number }> {
  let relationship = await ctx.gitService.classifyRemoteRelationship(worktreeDir, branch, localRef);
  if (relationship !== "indeterminate_shallow") return { relationship, deepenedTo: null, deepenFetches: 0 };

  let deepenedTo: number | null = null;
  let deepenFetches = 0;
  const targets = getDeepenTargets(ctx);
  const window = targets.length > 0 ? await measureDeepenWindow(clients.git, branch) : null;
  for (const target of targets) {
    if (window !== null && target <= window) {
      deepenedTo = target;
      continue;
    }
    await deepenShallowHistoryToDepth(ctx, clients, branch, target);
    deepenedTo = target;
    deepenFetches++;
    relationship = await ctx.gitService.classifyRemoteRelationship(worktreeDir, branch, localRef);
    if (relationship !== "indeterminate_shallow") break;
  }
  return { relationship, deepenedTo, deepenFetches };
}
