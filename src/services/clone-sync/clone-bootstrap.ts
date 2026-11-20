import * as fs from "fs/promises";
import * as path from "path";

import { PATH_CONSTANTS } from "../../constants";
import { ConfigError, GitOperationError } from "../../errors";
import { getErrorMessage } from "../../utils/errors";
import { fileExists, probePathExists } from "../../utils/file-exists";
import { appendGitAuthHint } from "../../utils/git-auth-error";
import { redactRepoUrl } from "../../utils/git-url";
import { isLfsError } from "../../utils/lfs-error";

import {
  assertPreviousCloneCompleted,
  clearIncompleteCloneMarker,
  getInitPendingMarkerPath,
  runInitialFileCopy,
  writeIncompleteCloneMarker,
} from "./clone-markers";
import { configureSingleBranchRemote, evaluateOriginMatch } from "./remote-config";
import { applySparseCheckoutAfterClone } from "./sparse";

import type { MutatingGitClients } from "./git-clients";
import type { CloneSkipDescriptor, CloneSkipReason, CloneSyncContext } from "./types";
import type { SparseCheckoutConfig } from "../../types";

export async function initializeClone(ctx: CloneSyncContext, branch: string): Promise<CloneSkipReason | null> {
  const worktreeDir = ctx.config.worktreeDir;
  const destination = await inspectCloneDestination(worktreeDir);
  if (destination === "clone") {
    return adoptExistingClone(ctx, worktreeDir, branch);
  }
  await cloneFresh(ctx, worktreeDir, branch, destination === "absent");
  return null;
}

export async function inspectCloneDestination(worktreeDir: string): Promise<"clone" | "absent" | "empty"> {
  let entries: string[] | null;
  try {
    entries = await fs.readdir(worktreeDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new GitOperationError(
        "clone-init",
        `Cannot inspect '${worktreeDir}' before cloning: ${getErrorMessage(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
    entries = null;
  }

  if (entries?.includes(PATH_CONSTANTS.GIT_DIR)) return "clone";

  if (entries && entries.length > 0) {
    throw new ConfigError(
      `Cannot clone into '${worktreeDir}': directory exists and is not empty. ` +
        `Remove existing contents or point worktreeDir at an empty path.`,
      "CLONE_DESTINATION_NOT_EMPTY",
    );
  }

  return entries === null ? "absent" : "empty";
}

interface CloneDestinationOwnership {
  createdDir: boolean;
  createdParent?: string;
}

async function prepareCloneDestination(
  worktreeDir: string,
  destinationWasAbsent: boolean,
): Promise<CloneDestinationOwnership> {
  if (!destinationWasAbsent) {
    await fs.mkdir(worktreeDir, { recursive: true });
    return { createdDir: false };
  }
  const createdParent = await fs.mkdir(path.dirname(worktreeDir), { recursive: true });
  try {
    await fs.mkdir(worktreeDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { createdDir: false };
  }
  return { createdDir: true, createdParent };
}

async function adoptExistingClone(
  ctx: CloneSyncContext,
  worktreeDir: string,
  branch: string,
): Promise<CloneSkipReason | null> {
  await assertPreviousCloneCompleted(worktreeDir);
  ctx.emitProgress({ phase: "clone", message: `Validating existing clone for '${ctx.repoName}'` });
  const invalid = await validateExistingClone(ctx, worktreeDir, branch);
  if (invalid) {
    ctx.recordSkip(invalid.skip, invalid.warnMessage, `Skipping '${ctx.repoName}': ${invalid.progressDetail}`);
    return invalid.skip;
  }
  const clients = await ctx.clients.mutatingClientsFor(worktreeDir);
  await configureSingleBranchRemote(ctx, clients, branch, { sweepStaleRefs: "always" });
  if (await fileExists(getInitPendingMarkerPath(worktreeDir))) {
    ctx.logger.info(`Completing interrupted initialization for '${ctx.repoName}'...`);
    await recordCloneTimeDefaultBranch(ctx, clients, branch);
    if (ctx.config.sparseCheckout) {
      await ctx.gitService.getSparseCheckoutService().applyToWorktree(worktreeDir, ctx.config.sparseCheckout);
      await clients.git.raw(["checkout", "HEAD"]);
    }
    await runInitialFileCopy(ctx, worktreeDir, branch);
  }
  ctx.emitProgress({ phase: "clone", message: `Existing clone validated for '${ctx.repoName}'` });
  return null;
}

async function recordCloneTimeDefaultBranch(
  ctx: CloneSyncContext,
  clients: MutatingGitClients,
  branch: string,
): Promise<void> {
  if (ctx.config.branch) return;
  try {
    await clients.git.raw(["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`]);
  } catch (error) {
    ctx.logger.warn(
      `Could not record '${branch}' as the clone-time default branch of '${ctx.repoName}': ${getErrorMessage(error)}`,
    );
  }
}

async function cloneFresh(
  ctx: CloneSyncContext,
  worktreeDir: string,
  branch: string,
  destinationWasAbsent: boolean,
): Promise<void> {
  const ownership = await prepareCloneDestination(worktreeDir, destinationWasAbsent);

  ctx.logger.info(`Cloning '${redactRepoUrl(ctx.config.repoUrl)}' (${branch}) into '${worktreeDir}'...`);
  ctx.emitProgress({ phase: "clone", message: `Cloning '${ctx.repoName}' (${branch})` });

  const cloneClient = ctx.clients.cloneClient();

  let checkoutRecovered = false;
  try {
    await cloneClient.clone(ctx.config.repoUrl, worktreeDir, buildCloneArgs(ctx, branch));
  } catch (error) {
    checkoutRecovered = await settleFailedClone(ctx, worktreeDir, ownership, error);
    if (!checkoutRecovered) {
      ctx.outcome?.recordFailed("repo", appendGitAuthHint(getErrorMessage(error)), {
        reason: "clone_failed",
        branch,
        path: worktreeDir,
      });
      throw error;
    }
  }

  try {
    await fs.writeFile(getInitPendingMarkerPath(worktreeDir), new Date().toISOString());
  } catch (error) {
    ctx.logger.warn(`Could not write clone-init pending marker: ${getErrorMessage(error)}`);
  }

  const freshClients = await ctx.clients.mutatingClientsFor(worktreeDir);
  await recordCloneTimeDefaultBranch(ctx, freshClients, branch);
  await configureSingleBranchRemote(ctx, freshClients, branch);

  ctx.logger.info(checkoutRecovered ? `✅ Clone completed (LFS content skipped).` : `✅ Clone successful.`);
  ctx.emitProgress({
    phase: "clone",
    message: checkoutRecovered
      ? `Clone completed for '${ctx.repoName}' with LFS content skipped`
      : `Clone successful for '${ctx.repoName}'`,
  });

  if (ctx.config.sparseCheckout) {
    ctx.logger.info(`Applying sparse-checkout patterns to '${worktreeDir}'...`);
    ctx.emitProgress({ phase: "sparse_checkout", message: `Applying sparse-checkout for '${ctx.repoName}'` });
    await checkOutSparseClone(ctx, freshClients, worktreeDir, ctx.config.sparseCheckout, checkoutRecovered);
    ctx.emitProgress({ phase: "sparse_checkout", message: `Sparse-checkout applied for '${ctx.repoName}'` });
  }

  ctx.emitProgress({ phase: "lfs", message: `Verifying LFS for '${ctx.repoName}'` });
  await ctx.gitService.verifyLfs(worktreeDir, branch);
  ctx.emitProgress({ phase: "lfs", message: `LFS verified for '${ctx.repoName}'` });

  await runInitialFileCopy(ctx, worktreeDir, branch);

  ctx.outcome?.recordCreated(branch, worktreeDir);
}

async function checkOutSparseClone(
  ctx: CloneSyncContext,
  clients: MutatingGitClients,
  worktreeDir: string,
  cfg: SparseCheckoutConfig,
  lfsSkipped: boolean,
): Promise<void> {
  await writeIncompleteCloneMarker(ctx, worktreeDir, "sparse checkout was interrupted");
  try {
    await applySparseCheckoutAfterClone(ctx, clients, worktreeDir, cfg, lfsSkipped);
  } catch (error) {
    const message = getErrorMessage(error);
    await writeIncompleteCloneMarker(ctx, worktreeDir, message);
    if (
      lfsSkipped ||
      !isLfsError(message) ||
      !(await retrySparseCheckoutWithLfsSkipped(ctx, clients, worktreeDir, cfg))
    ) {
      throw error;
    }
    ctx.logger.warn(
      `⚠️  '${ctx.repoName}' was checked out with LFS smudging disabled: its LFS paths hold pointer files ` +
        `until 'git lfs pull' succeeds there.`,
    );
  }
  await clearIncompleteCloneMarker(ctx, worktreeDir);
}

async function retrySparseCheckoutWithLfsSkipped(
  ctx: CloneSyncContext,
  clients: MutatingGitClients,
  worktreeDir: string,
  cfg: SparseCheckoutConfig,
): Promise<boolean> {
  ctx.logger.info(`⚠️  LFS error during checkout of '${ctx.repoName}'; retrying the checkout with LFS disabled.`);
  try {
    await applySparseCheckoutAfterClone(ctx, clients, worktreeDir, cfg, true);
    return true;
  } catch (error) {
    ctx.logger.warn(`Checkout retry with LFS disabled failed for '${ctx.repoName}': ${getErrorMessage(error)}`);
    return false;
  }
}

function buildCloneArgs(ctx: CloneSyncContext, branch: string): string[] {
  const args = ["--branch", branch, "--single-branch", "--no-tags", "--progress"];
  if (ctx.config.sparseCheckout) args.push("--no-checkout");
  if (ctx.config.depth !== undefined) {
    args.push("--depth", String(ctx.config.depth));
  }
  return args;
}

async function validateExistingClone(
  ctx: CloneSyncContext,
  worktreeDir: string,
  expectedBranch: string,
): Promise<CloneSkipDescriptor | null> {
  const git = ctx.clients.localClientFor(worktreeDir);

  const originMismatch = await evaluateOriginMatch(ctx, git, worktreeDir);
  if (originMismatch) return originMismatch;

  let currentBranch: string;
  try {
    currentBranch = (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    return {
      skip: { kind: "head_unreadable", phase: "init", error: errorMessage },
      warnMessage: `Existing clone at '${worktreeDir}' has a .git folder but reading HEAD failed: ${errorMessage}`,
      progressDetail: `could not read HEAD (${errorMessage})`,
    };
  }

  if (currentBranch !== expectedBranch) {
    return {
      skip: { kind: "branch_mismatch", phase: "init", currentBranch, expectedBranch },
      warnMessage:
        `Existing clone at '${worktreeDir}' is on branch '${currentBranch}', expected '${expectedBranch}'. ` +
        `Switch the working tree to '${expectedBranch}' or update the config.`,
      progressDetail: `current branch '${currentBranch}' is not '${expectedBranch}'`,
    };
  }

  return null;
}

async function settleFailedClone(
  ctx: CloneSyncContext,
  worktreeDir: string,
  ownership: CloneDestinationOwnership,
  cause: unknown,
): Promise<boolean> {
  const headProbe = await probePathExists(path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR, "HEAD"));
  if (headProbe === "missing") {
    await maybeCleanupPartialClone(ctx, worktreeDir, ownership);
    return false;
  }

  const message = getErrorMessage(cause);
  await writeIncompleteCloneMarker(ctx, worktreeDir, message);

  if (headProbe !== "exists" || !isLfsError(message) || !(await retryCheckoutWithLfsSkipped(ctx, worktreeDir))) {
    ctx.logger.warn(
      `Clone of '${ctx.repoName}' fetched its objects but left the working tree unfinished; leaving ` +
        `'${worktreeDir}' for manual inspection. The next run will refuse to adopt it until it is removed.`,
    );
    return false;
  }

  await clearIncompleteCloneMarker(ctx, worktreeDir);
  ctx.logger.warn(
    `⚠️  '${ctx.repoName}' was checked out with LFS smudging disabled: its LFS paths hold pointer files ` +
      `until 'git lfs pull' succeeds there.`,
  );
  return true;
}

async function retryCheckoutWithLfsSkipped(ctx: CloneSyncContext, worktreeDir: string): Promise<boolean> {
  ctx.logger.info(`⚠️  LFS error during clone of '${ctx.repoName}'; retrying the checkout with LFS disabled.`);
  ctx.emitProgress({ phase: "clone", message: `Retrying checkout for '${ctx.repoName}' with LFS disabled` });
  try {
    const clients = await ctx.clients.mutatingClientsFor(worktreeDir);
    await ctx.clients.lfsSkipCheckoutClient(clients, worktreeDir).raw(["checkout", "-f", "HEAD"]);
    return true;
  } catch (error) {
    ctx.logger.warn(`Checkout retry with LFS disabled failed for '${ctx.repoName}': ${getErrorMessage(error)}`);
    return false;
  }
}

async function maybeCleanupPartialClone(
  ctx: CloneSyncContext,
  worktreeDir: string,
  ownership: CloneDestinationOwnership,
): Promise<void> {
  if (!ownership.createdDir) {
    ctx.logger.warn(
      `Clone failed; leaving '${worktreeDir}' for manual inspection (directory existed before clone attempt).`,
    );
    return;
  }

  let entries: string[];
  try {
    entries = await fs.readdir(worktreeDir);
  } catch {
    return;
  }

  const looksIncomplete = entries.every((e) => e.startsWith("."));
  const hasUsableGit =
    entries.includes(PATH_CONSTANTS.GIT_DIR) &&
    (await fileExists(path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR, "HEAD")));

  if (looksIncomplete && !hasUsableGit) {
    try {
      await fs.rm(worktreeDir, { recursive: true, force: true });
      ctx.logger.info(`Cleaned up incomplete clone at '${worktreeDir}'.`);
      await removeCreatedParents(ctx, worktreeDir, ownership.createdParent);
    } catch (rmError) {
      ctx.logger.warn(`Failed to clean up incomplete clone at '${worktreeDir}': ${getErrorMessage(rmError)}`);
    }
  } else {
    ctx.logger.warn(
      `Clone failed; leaving '${worktreeDir}' for manual inspection (post-failure contents do not look like an empty incomplete clone).`,
    );
  }
}

async function removeCreatedParents(
  ctx: CloneSyncContext,
  worktreeDir: string,
  createdParent: string | undefined,
): Promise<void> {
  if (createdParent === undefined) return;
  const outermost = path.resolve(createdParent);
  let dir = path.dirname(path.resolve(worktreeDir));
  while (dir === outermost || dir.startsWith(outermost + path.sep)) {
    try {
      await fs.rmdir(dir);
    } catch {
      return;
    }
    if (dir === outermost) break;
    dir = path.dirname(dir);
  }
  ctx.logger.debug(`Removed the parent directories created for '${worktreeDir}'.`);
}
