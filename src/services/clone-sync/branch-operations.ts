import * as path from "path";

import { PATH_CONSTANTS } from "../../constants";
import { ConfigError, FastForwardError, GitOperationError, WorktreeNotCleanError } from "../../errors";
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

// The clone-mode branch switch behind CloneSyncService.checkoutBranch, from
// the origin check through the final remote narrowing. `targetBranch` is the
// branch the configuration resolves to; switching anywhere else needs
// `allowConfigDrift`. The caller records the new branch as tracked once this
// returns.
export async function switchCloneBranch(
  ctx: CloneSyncContext,
  branch: string,
  targetBranch: string,
  options: { allowConfigDrift?: boolean },
): Promise<void> {
  // Checkout is a convergence action by default: it brings an existing clone
  // in line with the configured branch. Arbitrary targets would leave
  // config.branch stale, so every later sync (and every restart) soft-skips
  // with branch_mismatch after the refspec was already narrowed.
  // allowConfigDrift is the TUI's explicit opt-out for branches it just
  // created and pushed — the drift is then intentional and warned about.
  if (branch !== targetBranch && !options.allowConfigDrift) {
    throw new ConfigError(
      ctx.config.branch
        ? `Cannot switch '${ctx.repoName}' to '${branch}': clone mode tracks the configured branch '${targetBranch}'. Update 'branch' in the config file first, then run checkout to converge.`
        : `Cannot switch '${ctx.repoName}' to '${branch}': no 'branch' is configured, so this clone tracks the remote default branch '${targetBranch}'. Set branch: "${branch}" in the config file first.`,
      "CLONE_BRANCH_MISMATCH",
    );
  }

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
  // On a detached HEAD `git switch` only warns about leaving commits behind,
  // and the restore path below cannot return to "HEAD" — refuse instead of
  // stranding commits in the reflog.
  if (currentBranch === "HEAD") {
    throw new GitOperationError(
      "checkout",
      `'${ctx.repoName}' is on a detached HEAD; check out a branch manually (preserving any local commits) before switching the tracked branch`,
    );
  }
  // Nothing above this line writes; everything below does. Refuse a linked
  // worktree or submodule here, before the first mutation reaches the
  // repository that actually owns this directory's git dir.
  const clients = await ctx.clients.mutatingClientsFor(worktreeDir);

  if (currentBranch === branch) {
    await configureSingleBranchRemote(ctx, clients, branch);
    return;
  }

  const isClean = await ctx.gitService.checkWorktreeStatus(worktreeDir);
  if (!isClean) {
    throw new WorktreeNotCleanError(worktreeDir, ["working tree has local changes"]);
  }

  // Converge shallow state like the sync tick does: with no configured depth an
  // existing shallow clone is unshallowed before the branch fetch, so switching
  // branches doesn't leave the new branch shallow while the rest is full.
  try {
    await unshallowIfDepthRemoved(ctx, clients);
  } catch (error) {
    // Same classification as the branch fetch below: a deleted tracked
    // branch fails the narrowed-refspec unshallow with the same error.
    if (isMissingRemoteRefError(getErrorMessage(error))) {
      throw new GitOperationError("checkout", `origin/${branch} is missing for '${ctx.repoName}'`);
    }
    throw error;
  }

  // `branch` is not always one the clone has never seen — localBranchExists
  // below has a path for a branch it already holds — so this fetch's `--depth`
  // can re-cut or deepen the clone rather than merely bound a new ref. See
  // buildUntrackedBranchFetchArgs.
  const fetchArgs = await buildUntrackedBranchFetchArgs(ctx, clients.git, branch);
  if ((await fetchWithRecovery(ctx, clients, fetchArgs, worktreeDir, branch, false)).skipped) {
    throw new GitOperationError("checkout", `origin/${branch} is missing for '${ctx.repoName}'`);
  }
  // Same post-fetch verify as the sync tick: a fetch can succeed without
  // materializing the ref, which would otherwise surface downstream as a
  // misleading FastForwardError.
  if (!(await hasRemoteBranch(clients.git, branch))) {
    throw new GitOperationError("checkout", `origin/${branch} did not materialize after fetch for '${ctx.repoName}'`);
  }

  if (await localBranchExists(clients.git, branch)) {
    // The same classification, and the same deepening budget, a sync tick
    // spends on this branch — asked about `refs/heads/<branch>` because the
    // switch has not happened yet, so a shallow clone whose remote moved
    // further than `depth` is deepened rather than refused.
    const { relationship, deepenedTo } = await classifyWithDeepening(
      ctx,
      clients,
      worktreeDir,
      branch,
      `refs/heads/${branch}`,
    );
    if (relationship === "indeterminate_shallow") {
      // Not a FastForwardError: nothing was established about the two
      // histories, and 'cannot fast-forward' is exactly the wrong thing to
      // tell a user whose branch may well be fast-forwardable.
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
        // This merge rejects the same way a sync's does, and leaves the same
        // half-applied checkout behind. It is reported loudly rather than
        // skipped, but the stray files would still wedge every later tick
        // with dirty_tree — and `git switch` back would have to carry them
        // across — so they are undone first.
        await undoRejectedFastForward(ctx, clients, worktreeDir, branch, headBeforeMerge);
        await restoreBranchAfterCheckoutFailure(ctx, clients, currentBranch, branch);
      }
      throw error;
    }
  } else {
    await clients.git.raw(["switch", "-c", branch, "--track", `origin/${branch}`]);
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

// resolvedBranch keeps in-session syncs on the new branch, but the config
// file still names the old one: the next process start will soft-skip with
// branch_mismatch on every tick until the config is updated.
export function warnConfigDriftAfterCheckout(ctx: CloneSyncContext, branch: string, targetBranch: string): void {
  if (branch === targetBranch) return;
  ctx.logger.warn(
    `⚠️ '${ctx.repoName}' now tracks '${branch}', but the config ${
      ctx.config.branch ? `still says branch '${targetBranch}'` : `resolves the remote default '${targetBranch}'`
    }. Set branch: "${branch}" in the config file — after a restart every sync will soft-skip with branch_mismatch until it matches.`,
  );
}

// The clone-mode half of the TUI's branch wizard. Worktree mode creates the
// branch in the bare repository; a clone-mode repo has none, and GitService's
// `bareRepoPath` falls back to the RELATIVE '.bare/<repo name>' there — a
// directory that does not exist or, when the daemon runs from a directory
// that happens to hold a bare store of the same repository NAME, another
// repository's refs. So the branch is created and published from the clone
// itself, which is also the only place that can afterwards check it out.
//
// Publishing transfers no objects: the new branch points at the tip of
// origin/<baseBranch>, which the remote already has, so a shallow clone can
// create and push it exactly like a full one and a sparse one is untouched —
// neither command reads the working tree. The caller follows with
// checkoutBranch(branchName, { allowConfigDrift: true }), which is where the
// tree actually switches and where shallow state converges.
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

  // checkoutBranch refuses a dirty tree, so a branch created now could never
  // be switched to. Refuse here instead, before anything reaches the remote:
  // the alternative leaves a published branch the user cannot move to.
  if (!(await ctx.gitService.checkWorktreeStatus(worktreeDir))) {
    throw new WorktreeNotCleanError(worktreeDir, [
      `'${ctx.repoName}' has local changes; commit or stash them before creating '${branchName}'`,
    ]);
  }

  // Same reason: checkoutBranch refuses a detached HEAD, so publishing first
  // would leave a branch on the remote that the switch afterwards cannot
  // move to.
  const currentBranch = (await readGit.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (currentBranch === "HEAD") {
    throw new GitOperationError(
      "branch",
      `Cannot create '${branchName}' in '${ctx.repoName}': it is on a detached HEAD; check out a branch manually (preserving any local commits) first`,
    );
  }

  // Both collision checks say "already exists": the TUI retries the whole
  // call with a '-1', '-2', ... suffix on exactly that wording, which is how
  // worktree mode has always behaved. The remote is asked as well as the
  // clone — a clone tracks one branch, so its refs cannot answer for a name
  // somebody else already pushed, and a plain push would quietly
  // fast-forward such a branch whenever it is an ancestor of the base.
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

  // Nothing above this line writes; everything below does. Refuse a linked
  // worktree or submodule here, before the fetch's refs land in the
  // repository that actually owns this directory's git dir.
  const clients = await ctx.clients.mutatingClientsFor(worktreeDir);

  // The clone tracks a single branch, so origin/<baseBranch> is often not
  // present at all, and when it is it is only as fresh as the last sync.
  // Fetch it with the same narrowed refspec — and the same shallow depth — a
  // sync's initial clone would use, so the branch starts at the tip the user
  // picked without dragging that branch's whole history in. When the pick is
  // the tracked branch, `--depth` lands on history the clone holds and can
  // re-cut or deepen it — see buildUntrackedBranchFetchArgs. The stray
  // origin/<baseBranch> this leaves behind is dropped below, as soon as the
  // new branch holds its tip.
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
    // The commonest failure here is a directory/file ref conflict -- 'feat'
    // already exists, so 'feat/sub' cannot be created. Say "already exists"
    // so the wizard suffixes and retries, which does resolve it, rather than
    // handing the user a bare git message with no repository in it.
    throw new GitOperationError(
      "branch",
      `cannot create '${branchName}' in '${ctx.repoName}': the name conflicts with a branch that ` +
        `already exists there (${summarizeGitFailure(getErrorMessage(error))}); choose another name`,
    );
  }
  const createdAt = await readBranchCommit(clients.git, branchName);
  ctx.logger.info(`Created branch '${branchName}' from 'origin/${baseBranch}' in '${ctx.repoName}'`);

  // The one ref this call added to a single-branch clone, dropped here
  // rather than by a sweep on some later tick: the local branch now holds
  // that tip, so nothing becomes unreachable, and every way out from here (a
  // failed push and its rollback included) leaves the clone with the one
  // remote-tracking ref it should have. The ref to keep is the TRACKED
  // branch's, which is what the refspec maintains — not the checked-out
  // one. They differ on a clone someone switched by hand, and guarding on
  // the checkout there would delete origin/<tracked>, the single ref the
  // refspec keeps.
  const trackedBranch = ctx.trackedBranch;
  if (baseBranch !== trackedBranch && baseBranch !== currentBranch) {
    await deleteRemoteTrackingRef(clients, `refs/remotes/origin/${baseBranch}`);
  }

  try {
    // `--force-with-lease` with an empty expected value is git's create-only
    // push: it requires the remote ref not to exist, closing the window
    // between the ls-remote above and this push. It can never force-update
    // anything — an existing ref is rejected with "stale info" instead.
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

// Every client is built on this directory, and simple-git's constructor
// rejects a missing one with "Cannot use simple-git on a directory that does
// not exist" — a message that names neither the repository nor a remedy. The
// absence is reported here instead.
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

// A fully-qualified `ls-remote` pattern matches that one ref and nothing that
// merely starts with it, so this answers for exactly <branch>.
async function remoteBranchExists(ctx: CloneSyncContext, worktreeDir: string, branch: string): Promise<boolean> {
  const output = await ctx.clients
    .networkClientFor(path.resolve(worktreeDir))
    .raw(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
  return parseLsRemoteHeads(output).includes(branch);
}

// A push that never landed must not leave the local branch behind: the
// wizard reports the failure and offers the same name again, and the next
// attempt would then collide with this repository's own leftover. The delete
// is a compare-and-swap on the commit the branch was created at, so a ref
// something else moved in the meantime is left alone — and a leftover that
// could not be removed is named in the error rather than passed over.
async function rollbackCreatedBranch(
  ctx: CloneSyncContext,
  clients: MutatingGitClients,
  worktreeDir: string,
  branchName: string,
  createdAt: string | null,
  pushError: unknown,
): Promise<never> {
  const message = redactSecretsInText(getErrorMessage(pushError));
  // "stale info" is how the create-only lease reports a ref that appeared
  // between the ls-remote and the push; it reads as a collision, not as a
  // stale remote-tracking ref, so it is phrased as one — and the "already
  // exists" wording sends the TUI round again with a suffixed name.
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

  throw new GitOperationError("push", `${detail}.${leftover}`, pushError instanceof Error ? pushError : undefined);
}
