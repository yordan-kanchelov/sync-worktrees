import * as fs from "fs/promises";
import * as path from "path";

import { PATH_CONSTANTS } from "../../constants";
import { GitOperationError } from "../../errors";
import { getErrorMessage } from "../../utils/errors";
import { fileExists } from "../../utils/file-exists";
import { redactSecretsInText } from "../../utils/git-url";

import { summarizeGitFailure } from "./git-helpers";

import type { CloneSyncContext } from "./types";

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
  const recorded = redactSecretsInText(failure);
  const contents = `${new Date().toISOString()}\n${summarizeGitFailure(recorded)}\n${recorded}\n`;
  try {
    await fs.writeFile(getIncompleteCloneMarkerPath(worktreeDir), contents);
  } catch (error) {
    ctx.logger.warn(`Could not write the incomplete-clone marker: ${getErrorMessage(error)}`);
  }
}

export async function clearIncompleteCloneMarker(ctx: CloneSyncContext, worktreeDir: string): Promise<void> {
  try {
    await fs.rm(getIncompleteCloneMarkerPath(worktreeDir), { force: true });
  } catch (error) {
    ctx.logger.warn(`Could not remove the incomplete-clone marker: ${getErrorMessage(error)}`);
  }
}

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
  if (typeof contents !== "string") return { status: "absent" };
  const cause = contents.split(/\r?\n/)[1]?.trim();
  return { status: "present", cause: cause && cause.length > 0 ? cause : "reason not recorded" };
}

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
    } catch {}
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
