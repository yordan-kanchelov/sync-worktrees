import * as fs from "fs/promises";
import * as path from "path";

import { PATH_CONSTANTS } from "../../constants";
import { GitOperationError } from "../../errors";
import { getErrorMessage } from "../../utils/errors";
import { fileExists } from "../../utils/file-exists";
import { redactSecretsInText } from "../../utils/git-url";

import { summarizeGitFailure } from "./git-helpers";

import type { CloneSyncContext } from "./types";

// The three files init keeps inside a clone's `.git` — inside rather than in
// the working tree, where a marker would show up as an untracked file in
// every status this tool takes:
//
//   init marker — the initial file copy ran; written once, never removed.
//   init pending marker — a clone of ours whose post-clone steps have not all
//     finished; the next init that adopts it runs them again.
//   incomplete-clone marker — a clone of ours whose checkout never finished;
//     the next init refuses to adopt it at all.

function getInitMarkerPath(worktreeDir: string): string {
  return path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR, PATH_CONSTANTS.CLONE_INIT_MARKER);
}

export function getInitPendingMarkerPath(worktreeDir: string): string {
  return path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR, PATH_CONSTANTS.CLONE_INIT_PENDING_MARKER);
}

function getIncompleteCloneMarkerPath(worktreeDir: string): string {
  return path.join(worktreeDir, PATH_CONSTANTS.GIT_DIR, PATH_CONSTANTS.CLONE_INCOMPLETE_MARKER);
}

export async function writeIncompleteCloneMarker(
  ctx: CloneSyncContext,
  worktreeDir: string,
  failure: string,
): Promise<void> {
  // Line 1 when the clone failed, line 2 what the refusal quotes, then git's
  // untruncated stderr for whoever opens the file. Redacted on the way in
  // like every other string clone mode surfaces: a repoUrl carrying a token
  // reaches git's own output, and this one is written to disk and read back
  // into an error message on every later run.
  const recorded = redactSecretsInText(failure);
  const contents = `${new Date().toISOString()}\n${summarizeGitFailure(recorded)}\n${recorded}\n`;
  try {
    await fs.writeFile(getIncompleteCloneMarkerPath(worktreeDir), contents);
  } catch (error) {
    // Best effort, like the init pending marker: without it the next run
    // falls back to the old behaviour of adopting the unfinished clone.
    ctx.logger.warn(`Could not write the incomplete-clone marker: ${getErrorMessage(error)}`);
  }
}

export async function clearIncompleteCloneMarker(ctx: CloneSyncContext, worktreeDir: string): Promise<void> {
  try {
    await fs.rm(getIncompleteCloneMarkerPath(worktreeDir), { force: true });
  } catch (error) {
    // A marker left behind on a repaired clone costs a hard error on the
    // next run, which names the file and how to remove it.
    ctx.logger.warn(`Could not remove the incomplete-clone marker: ${getErrorMessage(error)}`);
  }
}

// Read rather than probed for existence: the marker's second line is why the
// clone failed, and that is what the refusal quotes.
//
// Three answers, never two. This marker is the only thing that tells a clone
// of ours that never finished from a clone the user made, so "the file could
// not be read" must not collapse into "there is no such file" — the same
// rule probePathExists states for removal decisions. Only ENOENT (and
// ENOTDIR, a `.git` that is not a directory) prove absence; EACCES, EIO or
// an EISDIR marker leave the question open, and the caller fails closed.
async function readIncompleteCloneMarker(
  worktreeDir: string,
): Promise<{ status: "absent" } | { status: "present"; cause: string } | { status: "unreadable"; detail: string }> {
  let contents: string | undefined;
  try {
    contents = await fs.readFile(getIncompleteCloneMarkerPath(worktreeDir), "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "absent" };
    return { status: "unreadable", detail: getErrorMessage(error) };
  }
  // Same normalization lstatOrNull and realPathOrNull apply: an answer that
  // is not the shape the API promises is not passed on as a verdict.
  if (typeof contents !== "string") return { status: "absent" };
  const cause = contents.split(/\r?\n/)[1]?.trim();
  return { status: "present", cause: cause && cause.length > 0 ? cause : "reason not recorded" };
}

// A clone this tool started and could not finish is not a clone it may
// adopt: its working tree was never fully written, so every sync would find
// staged deletions plus untracked files and soft-skip with `dirty_tree` — an
// info-level line and exit 0 — for a directory the user never touched.
//
// A GitOperationError rather than the ConfigError the primary-checkout guard
// raises: nothing is wrong with the configuration — worktreeDir is a path
// this tool owns and may clone into — what failed is a git operation on it,
// and the remedy is on disk. It also matches the GitOperationError the same
// init throws when it cannot inspect the destination.
export async function assertPreviousCloneCompleted(worktreeDir: string): Promise<void> {
  const marker = await readIncompleteCloneMarker(worktreeDir);
  if (marker.status === "absent") return;

  if (marker.status === "unreadable") {
    throw new GitOperationError(
      "clone-init",
      `cannot tell whether the clone of '${worktreeDir}' completed: its incomplete-clone marker ` +
        `'${getIncompleteCloneMarkerPath(worktreeDir)}' could not be read (${marker.detail}). Adopting the ` +
        `clone without that answer would sync a working tree that may never have been checked out; make the ` +
        `file readable, or remove the directory and let the next run clone again.`,
    );
  }

  throw new GitOperationError(
    "clone-init",
    `previous clone of '${worktreeDir}' did not complete (${marker.cause}); its working tree was never fully checked ` +
      `out, so syncing it would report local changes on every run. Remove the directory and let the next run ` +
      `clone again, or fix the cause, run 'git -C ${worktreeDir} checkout -f HEAD' and delete ` +
      `'${getIncompleteCloneMarkerPath(worktreeDir)}'.`,
  );
}

export async function runInitialFileCopy(ctx: CloneSyncContext, worktreeDir: string, branch: string): Promise<void> {
  const marker = getInitMarkerPath(worktreeDir);
  const pendingMarker = getInitPendingMarkerPath(worktreeDir);
  if (await fileExists(marker)) {
    try {
      await fs.rm(pendingMarker, { force: true });
    } catch {
      // A stale pending marker is harmless; the final marker wins.
    }
    return;
  }

  const sourceDir = ctx.config.__configFileDir ?? worktreeDir;

  await ctx.branchCreatedActions.copyFiles({
    config: ctx.config,
    branchName: branch,
    worktreePath: worktreeDir,
    sourceDir,
    logger: ctx.logger,
  });

  try {
    await fs.writeFile(marker, new Date().toISOString());
    await fs.rm(pendingMarker, { force: true });
  } catch (error) {
    ctx.logger.warn(`Could not write clone-init marker: ${getErrorMessage(error)}`);
  }
}
