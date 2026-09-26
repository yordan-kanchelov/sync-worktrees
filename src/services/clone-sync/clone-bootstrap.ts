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

import type { CloneSkipDescriptor, CloneSkipReason, CloneSyncContext } from "./types";

// Brings `config.worktreeDir` to a clone init can hand to the sync tick:
// adopts an existing clone (after validating it), or clones into an absent or
// empty directory and runs the post-clone steps. Returns the skip recorded for
// an existing clone that cannot be synced as configured, so the caller can
// keep the tick that follows from recording it a second time; null otherwise.
export async function initializeClone(ctx: CloneSyncContext, branch: string): Promise<CloneSkipReason | null> {
  const worktreeDir = ctx.config.worktreeDir;

  let entries: string[] | null;
  try {
    entries = await fs.readdir(worktreeDir);
  } catch (error) {
    // Only a definitively missing directory may proceed as a fresh clone: it
    // is what lets prepareCloneDestination claim the destination, and that
    // claim authorizes maybeCleanupPartialClone to rm -rf the directory
    // after a failed clone, so a transient probe failure
    // (EMFILE, EACCES) must never read as "the directory did not exist" —
    // that would delete a pre-existing directory the tool never created.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new GitOperationError(
        "clone-init",
        `Cannot inspect '${worktreeDir}' before cloning: ${getErrorMessage(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
    entries = null;
  }

  if (entries?.includes(PATH_CONSTANTS.GIT_DIR)) {
    return adoptExistingClone(ctx, worktreeDir, branch);
  }

  if (entries && entries.length > 0) {
    throw new ConfigError(
      `Cannot clone into '${worktreeDir}': directory exists and is not empty. ` +
        `Remove existing contents or point worktreeDir at an empty path.`,
      "CLONE_DESTINATION_NOT_EMPTY",
    );
  }

  await cloneFresh(ctx, worktreeDir, branch, entries === null);
  return null;
}

// What a failed clone may remove. `createdDir` is true only when this init's
// own mkdir made the destination; `createdParent` is the outermost ancestor the
// same call had to create on the way, if any.
interface CloneDestinationOwnership {
  createdDir: boolean;
  createdParent?: string;
}

// The readdir that found the destination missing proves only that it was
// absent a moment ago, not that this process is the one that creates it. So
// the parents are made first and the destination itself with a plain,
// non-recursive mkdir: EEXIST there means somebody else created it in that
// window, and a directory somebody else created is never this init's to
// delete. A destination that already existed (empty) is not ours either.
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
  // Before anything treats this directory as a clone somebody else made:
  // one of ours that never finished checking out must never be adopted.
  // First, and not after validateExistingClone, because that path answers
  // with soft skips — a wrong branch or a changed origin would return
  // early and the real problem would never be reported at all.
  await assertPreviousCloneCompleted(worktreeDir);
  ctx.emitProgress({ phase: "clone", message: `Validating existing clone for '${ctx.repoName}'` });
  const invalid = await validateExistingClone(ctx, worktreeDir, branch);
  if (invalid) {
    ctx.recordSkip(invalid.skip, invalid.warnMessage, `Skipping '${ctx.repoName}': ${invalid.progressDetail}`);
    return invalid.skip;
  }
  // validateExistingClone only reads. Adopting the directory — narrowing
  // its refspec, deleting its stale remote-tracking refs — starts here, so
  // this is where a non-primary checkout has to be refused.
  const clients = await ctx.clients.mutatingClientsFor(worktreeDir);
  // The one call that sweeps stale refs whether or not it had to touch the
  // refspec: this directory is a clone somebody else made, or one an older
  // version of this tool left behind, so a refspec that already reads
  // narrow proves nothing about the refs sitting next to it. It runs once
  // per process, not once per tick.
  await configureSingleBranchRemote(ctx, clients, branch, { sweepStaleRefs: "always" });
  // A pending marker means this clone was created by an init of ours that
  // was interrupted after the clone — finish the post-clone steps now.
  // Sparse setup is re-run too (idempotent), so an init that died inside
  // it does not leave the clone permanently un-narrowed. The marker is
  // deliberately written before every one of those steps, the refspec
  // narrowing included: written after any of them, a failure there would
  // leave no marker and the file copy would be silently dropped forever.
  // Pre-existing user clones never carry the marker and are left alone.
  if (await fileExists(getInitPendingMarkerPath(worktreeDir))) {
    ctx.logger.info(`Completing interrupted initialization for '${ctx.repoName}'...`);
    if (ctx.config.sparseCheckout) {
      await ctx.gitService.getSparseCheckoutService().applyToWorktree(worktreeDir, ctx.config.sparseCheckout);
      await clients.git.raw(["checkout", "HEAD"]);
    }
    await runInitialFileCopy(ctx, worktreeDir, branch);
  }
  ctx.emitProgress({ phase: "clone", message: `Existing clone validated for '${ctx.repoName}'` });
  return null;
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
      // The outcome is what the MCP `sync` result and the run summary show, so
      // carry the credential hint there too (the thrown error gets it at the
      // WorktreeSyncService funnel).
      ctx.outcome?.recordFailed("repo", appendGitAuthHint(getErrorMessage(error)), {
        reason: "clone_failed",
        branch,
        path: worktreeDir,
      });
      throw error;
    }
  }

  // The clone is on disk from here on, and every step that follows can fail
  // or be killed — leaving a valid-looking clone that the next init adopts
  // via the existing-clone path, which runs the file copy only for a clone
  // carrying this marker. So the marker goes down first, before the refspec
  // narrowing (which the adoption path re-runs anyway) and before anything
  // else touches the clone. That shortens the window rather than closing it —
  // `clone` returning and this write are two operations — but what is left is
  // a single file write rather than the git subprocesses the narrowing spawns.
  try {
    await fs.writeFile(getInitPendingMarkerPath(worktreeDir), new Date().toISOString());
  } catch (error) {
    ctx.logger.warn(`Could not write clone-init pending marker: ${getErrorMessage(error)}`);
  }

  const freshClients = await ctx.clients.mutatingClientsFor(worktreeDir);
  await configureSingleBranchRemote(ctx, freshClients, branch);

  // The progress stream carries the same nuance as the log: a TUI showing
  // "Clone successful" for a tree that holds pointer files is not the truth.
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
    await applySparseCheckoutAfterClone(ctx, freshClients, worktreeDir, ctx.config.sparseCheckout, checkoutRecovered);
    ctx.emitProgress({ phase: "sparse_checkout", message: `Sparse-checkout applied for '${ctx.repoName}'` });
  }

  ctx.emitProgress({ phase: "lfs", message: `Verifying LFS for '${ctx.repoName}'` });
  await ctx.gitService.verifyLfs(worktreeDir, branch);
  ctx.emitProgress({ phase: "lfs", message: `LFS verified for '${ctx.repoName}'` });

  await runInitialFileCopy(ctx, worktreeDir, branch);

  // Only record `created` once init is fully complete; otherwise an aborted
  // post-clone step would leave the outcome reporting both created and failed.
  ctx.outcome?.recordCreated(branch, worktreeDir);
}

function buildCloneArgs(ctx: CloneSyncContext, branch: string): string[] {
  const args = ["--branch", branch, "--single-branch", "--no-tags", "--progress"];
  if (ctx.config.depth !== undefined) {
    args.push("--depth", String(ctx.config.depth));
  }
  return args;
}

// Null when the existing clone can be adopted as configured; otherwise the
// skip that says why not. Reads only.
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

// A failed clone leaves the destination in one of two shapes, and each has
// its own settlement. A clone that never got as far as writing HEAD leaves
// rubbish maybeCleanupPartialClone removes when we created the directory. A
// clone that fetched every object and then failed to check out ("Clone
// succeeded, but checkout failed", exit 128 — a missing LFS object is the
// usual cause) leaves a complete `.git` on the tracked branch next to a
// half-written tree, and nothing on disk tells that apart from a clone the
// user made: validateExistingClone passes it, so without a marker the next
// run would adopt it as a pre-existing clone — no checkout retry, no sparse
// setup, no LFS verify, no file copy — and report `dirty_tree` forever.
//
// Everything under that path is this clone's own work: the destination was
// verified absent or empty before it started (a directory that is neither
// never reaches the clone). So the checkout may be retried in place, and
// when it cannot be, the directory is marked as ours-and-unfinished so the
// next init refuses to adopt it. Returns true when the working tree was
// repaired and the caller may continue with the post-clone steps.
//
// Known limit: this runs only once `git clone` has returned, so a process
// killed mid-checkout still leaves an unmarked half-written clone; see
// docs/internal/clone-mode-notes.md.
async function settleFailedClone(
  ctx: CloneSyncContext,
  worktreeDir: string,
  ownership: CloneDestinationOwnership,
  cause: unknown,
): Promise<boolean> {
  // Only a definitively absent HEAD may reach maybeCleanupPartialClone: its
  // rm -rf arm is live for a directory this init created, and a probe that
  // merely failed (EACCES on the destination, EMFILE under load) must never
  // read as "nothing was fetched here". An unverifiable one is marked like a
  // fetched clone instead — marking deletes nothing, and refusing to adopt a
  // directory that turns out to be fine costs an error the user can clear.
  const headProbe = await probePathExists(path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR, "HEAD"));
  if (headProbe === "missing") {
    await maybeCleanupPartialClone(ctx, worktreeDir, ownership);
    return false;
  }

  const message = getErrorMessage(cause);
  // Marked before the retry, never after: a process killed in the middle of
  // the retry must still leave a directory the next run refuses to adopt.
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

// Retries only the checkout half of a clone whose objects already landed,
// with LFS smudging forced off — the same recovery fetchWithRecovery applies
// to a fetch, and the same one worktree mode applies to a `worktree add`.
// Reports success rather than throwing: the caller is already holding the
// clone's failure and must report that one, not this one.
async function retryCheckoutWithLfsSkipped(ctx: CloneSyncContext, worktreeDir: string): Promise<boolean> {
  ctx.logger.info(`⚠️  LFS error during clone of '${ctx.repoName}'; retrying the checkout with LFS disabled.`);
  ctx.emitProgress({ phase: "clone", message: `Retrying checkout for '${ctx.repoName}' with LFS disabled` });
  try {
    // `checkout -f HEAD` is a write, so it goes through the primary-checkout
    // guard like every other one — even here, where the directory is one
    // this init just cloned into.
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

// The parents this init's mkdir created for the destination, innermost first,
// up to and including the outermost one it made. rmdir only ever removes an
// empty directory, so anything another process put there in the meantime
// stops the walk instead of being deleted with it.
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
