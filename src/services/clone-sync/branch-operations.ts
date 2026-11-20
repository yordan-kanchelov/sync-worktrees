import * as path from "path";

import { PATH_CONSTANTS } from "../../constants";
import {
  ConfigError,
  FastForwardError,
  GitOperationError,
  UnpushedBranchLeftoverError,
  WorktreeNotCleanError,
} from "../../errors";
import { getErrorMessage } from "../../utils/errors";
import { probePathExists } from "../../utils/file-exists";
import { appendGitAuthHint } from "../../utils/git-auth-error";
import { redactSecretsInText } from "../../utils/git-url";
import { isMissingRemoteRefError } from "../../utils/lfs-error";

import { undoRejectedFastForward } from "./fast-forward-undo";
import {
  buildUntrackedBranchFetchArgs,
  classifyWithDeepening,
  describeDeepenAttempt,
  fetchWithRecovery,
  unshallowIfDepthRemoved,
} from "./fetch";
import {
  hasRemoteBranch,
  localBranchExists,
  parseLsRemoteHeads,
  readBranchCommit,
  readHeadCommit,
  summarizeGitFailure,
} from "./git-helpers";
import { configureSingleBranchRemote, deleteRemoteTrackingRef, evaluateOriginMatch } from "./remote-config";

import type { MutatingGitClients } from "./git-clients";
import type { CloneSyncContext } from "./types";

export async function switchCloneBranch(ctx: CloneSyncContext, branch: string): Promise<void> {
  const worktreeDir = ctx.config.worktreeDir;
  const readGit = ctx.clients.localClientFor(worktreeDir);
  const originMismatch = await evaluateOriginMatch(ctx, readGit, worktreeDir);
  if (originMismatch) {
    throw new ConfigError(
      `Cannot switch '${ctx.repoName}' to '${branch}': ${originMismatch.progressDetail}.`,
      "ORIGIN_MISMATCH",
    );
  }

  const currentBranch = (await readGit.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (currentBranch === "HEAD") {
    throw new GitOperationError(
      "checkout",
      `'${ctx.repoName}' is on a detached HEAD; check out a branch manually (preserving any local commits) before switching the tracked branch`,
    );
  }
  if (!(await localBranchExists(readGit, branch))) {
    throw new GitOperationError("checkout", `'${ctx.repoName}' has no local branch '${branch}' to switch to`);
  }
  const clients = await ctx.clients.mutatingClientsFor(worktreeDir);

  const isClean = await ctx.gitService.checkWorktreeStatus(worktreeDir);
  if (!isClean) {
    throw new WorktreeNotCleanError(worktreeDir, ["working tree has local changes"]);
  }

  try {
    await unshallowIfDepthRemoved(ctx, clients);
  } catch (error) {
    if (isMissingRemoteRefError(getErrorMessage(error))) {
      throw new GitOperationError("checkout", `origin/${branch} is missing for '${ctx.repoName}'`);
    }
    throw error;
  }

  const fetchArgs = await buildUntrackedBranchFetchArgs(ctx, clients.git, branch);
  if ((await fetchWithRecovery(ctx, clients, fetchArgs, worktreeDir, branch, false)).skipped) {
    throw new GitOperationError("checkout", `origin/${branch} is missing for '${ctx.repoName}'`);
  }
  if (!(await hasRemoteBranch(clients.git, branch))) {
    throw new GitOperationError("checkout", `origin/${branch} did not materialize after fetch for '${ctx.repoName}'`);
  }

  const { relationship, deepenedTo } = await classifyWithDeepening(
    ctx,
    clients,
    worktreeDir,
    branch,
    `refs/heads/${branch}`,
  );
  if (relationship === "indeterminate_shallow") {
    throw new GitOperationError(
      "checkout",
      `cannot tell whether '${branch}' fast-forwards to origin/${branch} in '${ctx.repoName}': the clone is ` +
        `shallow and the histories do not meet after ${describeDeepenAttempt(deepenedTo)}. ` +
        `Remove 'depth' from the config to unshallow the clone, then switch again`,
    );
  }
  if (relationship !== "up_to_date" && relationship !== "fast_forward") {
    throw new FastForwardError(branch);
  }

  let switched = false;
  let headBeforeMerge: string | null = null;
  try {
    await clients.git.raw(["switch", branch]);
    switched = true;
    headBeforeMerge = await readHeadCommit(clients.git);
    await clients.git.merge([`origin/${branch}`, "--ff-only"]);
  } catch (error) {
    if (switched) {
      await undoRejectedFastForward(ctx, clients, worktreeDir, branch, headBeforeMerge);
      await restoreBranchAfterCheckoutFailure(ctx, clients, currentBranch, branch);
    }
    throw error;
  }

  await configureSingleBranchRemote(ctx, clients, branch);
}

async function restoreBranchAfterCheckoutFailure(
  ctx: CloneSyncContext,
  clients: MutatingGitClients,
  previousBranch: string,
  attemptedBranch: string,
): Promise<void> {
  if (!previousBranch || previousBranch === "HEAD" || previousBranch === attemptedBranch) return;

  try {
    await clients.git.raw(["switch", previousBranch]);
  } catch (error) {
    ctx.logger.warn(
      `Failed to restore '${ctx.repoName}' to '${previousBranch}' after checkout failure: ${getErrorMessage(error)}`,
    );
  }
}

export function warnConfigDriftAfterCheckout(ctx: CloneSyncContext, branch: string, targetBranch: string): void {
  if (branch === targetBranch) return;
  ctx.logger.warn(
    `⚠️ '${ctx.repoName}' now tracks '${branch}', but the config ${
      ctx.config.branch ? `still says branch '${targetBranch}'` : `resolves the remote default '${targetBranch}'`
    }. Set branch: "${branch}" in the config file — after a restart every sync will soft-skip with branch_mismatch until it matches.`,
  );
}

export async function createAndPushCloneBranch(
  ctx: CloneSyncContext,
  baseBranch: string,
  branchName: string,
): Promise<void> {
  const worktreeDir = ctx.config.worktreeDir;
  await assertCloneDirectoryPresent(ctx, worktreeDir, branchName);

  const readGit = ctx.clients.localClientFor(worktreeDir);
  const originMismatch = await evaluateOriginMatch(ctx, readGit, worktreeDir);
  if (originMismatch) {
    throw new ConfigError(
      `Cannot create '${branchName}' in '${ctx.repoName}': ${originMismatch.progressDetail}.`,
      "ORIGIN_MISMATCH",
    );
  }

  if (!(await ctx.gitService.checkWorktreeStatus(worktreeDir))) {
    throw new WorktreeNotCleanError(worktreeDir, [
      `'${ctx.repoName}' has local changes; commit or stash them before creating '${branchName}'`,
    ]);
  }

  const currentBranch = (await readGit.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (currentBranch === "HEAD") {
    throw new GitOperationError(
      "branch",
      `Cannot create '${branchName}' in '${ctx.repoName}': it is on a detached HEAD; check out a branch manually (preserving any local commits) first`,
    );
  }

  if (await localBranchExists(readGit, branchName)) {
    throw new GitOperationError(
      "branch",
      `branch '${branchName}' already exists in the clone at '${path.resolve(worktreeDir)}' for ` +
        `'${ctx.repoName}'; choose another name, or delete it with ` +
        `\`git -C "${path.resolve(worktreeDir)}" branch -D ${branchName}\``,
    );
  }
  if (await remoteBranchExists(ctx, worktreeDir, branchName)) {
    throw new GitOperationError(
      "branch",
      `branch '${branchName}' already exists on the remote of '${ctx.repoName}'; choose another name`,
    );
  }

  const clients = await ctx.clients.mutatingClientsFor(worktreeDir);

  const fetchArgs = await buildUntrackedBranchFetchArgs(ctx, clients.git, baseBranch);
  if ((await fetchWithRecovery(ctx, clients, fetchArgs, worktreeDir, baseBranch, false)).skipped) {
    throw new GitOperationError(
      "branch",
      `cannot create '${branchName}' in '${ctx.repoName}': origin/${baseBranch} is missing on the remote`,
    );
  }
  if (!(await hasRemoteBranch(clients.git, baseBranch))) {
    throw new GitOperationError(
      "branch",
      `cannot create '${branchName}' in '${ctx.repoName}': origin/${baseBranch} did not materialize after fetch`,
    );
  }

  try {
    await clients.git.raw(["branch", "--no-track", branchName, `origin/${baseBranch}`]);
  } catch (error) {
    throw describeBranchCreateFailure(ctx, branchName, getErrorMessage(error));
  }
  const createdAt = await readBranchCommit(clients.git, branchName);
  ctx.logger.info(`Created branch '${branchName}' from 'origin/${baseBranch}' in '${ctx.repoName}'`);

  const trackedBranch = ctx.trackedBranch;
  if (baseBranch !== trackedBranch && baseBranch !== currentBranch) {
    await deleteRemoteTrackingRef(clients, `refs/remotes/origin/${baseBranch}`);
  }

  try {
    await clients.networkGit.push([
      "origin",
      `refs/heads/${branchName}:refs/heads/${branchName}`,
      "-u",
      `--force-with-lease=refs/heads/${branchName}:`,
    ]);
  } catch (error) {
    await rollbackCreatedBranch(ctx, clients, worktreeDir, branchName, createdAt, error);
  }
  ctx.logger.info(`Pushed branch '${branchName}' to the remote of '${ctx.repoName}'`);
}

async function assertCloneDirectoryPresent(
  ctx: CloneSyncContext,
  worktreeDir: string,
  branchName: string,
): Promise<void> {
  const probe = await probePathExists(path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR));
  if (probe === "exists") return;
  throw new ConfigError(
    `Cannot create '${branchName}' in '${ctx.repoName}': '${path.resolve(worktreeDir)}' ` +
      `${probe === "missing" ? "is not a git clone" : "could not be inspected"}. Sync this repository once so ` +
      `the clone exists, then create the branch again.`,
    "CLONE_DESTINATION_MISSING",
  );
}

async function remoteBranchExists(ctx: CloneSyncContext, worktreeDir: string, branch: string): Promise<boolean> {
  const output = await ctx.clients
    .networkClientFor(path.resolve(worktreeDir))
    .raw(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
  return parseLsRemoteHeads(output).includes(branch);
}

async function rollbackCreatedBranch(
  ctx: CloneSyncContext,
  clients: MutatingGitClients,
  worktreeDir: string,
  branchName: string,
  createdAt: string | null,
  pushError: unknown,
): Promise<never> {
  const message = redactSecretsInText(getErrorMessage(pushError));
  const detail = message.includes("stale info")
    ? `branch '${branchName}' already exists on the remote of '${ctx.repoName}' — it was pushed while this one ` +
      `was being prepared; choose another name`
    : `could not push '${branchName}' to the remote of '${ctx.repoName}': ${appendGitAuthHint(message)}`;

  let leftover = "";
  try {
    if (createdAt === null) {
      throw new Error("the commit it was created at could not be read");
    }
    await clients.git.raw(["update-ref", "-d", `refs/heads/${branchName}`, createdAt]);
  } catch (deleteError) {
    leftover =
      ` The local branch '${branchName}' is still in the clone — removing it failed ` +
      `(${getErrorMessage(deleteError)}); delete it with ` +
      `\`git -C "${path.resolve(worktreeDir)}" branch -D ${branchName}\`.`;
  }

  const cause = pushError instanceof Error ? pushError : undefined;
  if (leftover) throw new UnpushedBranchLeftoverError(`${detail}.${leftover}`, cause);
  throw new GitOperationError("push", `${detail}.${leftover}`, cause);
}

function describeBranchCreateFailure(ctx: CloneSyncContext, branchName: string, message: string): GitOperationError {
  const prefix = `cannot create '${branchName}' in '${ctx.repoName}'`;
  const blocking = /'(refs\/heads\/[^']+)' exists; cannot create/.exec(message)?.[1];
  if (blocking && `refs/heads/${branchName}`.startsWith(`${blocking}/`)) {
    return new GitOperationError(
      "branch",
      `${prefix}: the branch '${blocking}' exists, so no branch can be created under it; ` +
        `choose a name outside '${blocking.slice("refs/heads/".length)}/'`,
    );
  }
  const summary = summarizeGitFailure(message);
  if (blocking || /blocking reference/.test(message)) {
    return new GitOperationError(
      "branch",
      `${prefix}: the name conflicts with a branch that already exists there (${summary}); choose another name`,
    );
  }
  return new GitOperationError("branch", `${prefix}: ${summary}`);
}
