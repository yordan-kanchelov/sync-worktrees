import * as fs from "fs/promises";
import * as path from "path";

import { getErrorMessage } from "../../utils/errors";
import { unbucketedTrackedPaths } from "../worktree-status.service";

import { asLiteralPathspec, inBatches, lstatOrNull, readHeadCommit, summarizeGitFailure } from "./git-helpers";

import type { MutatingGitClients } from "./git-clients";
import type { CloneSyncContext } from "./types";
import type { SimpleGit } from "simple-git";

export type FastForwardUndoHost = Pick<CloneSyncContext, "logger" | "repoName" | "emitProgress">;

const MERGE_CLEANUP_PATH_BATCH = 200;

const MERGE_CLEANUP_LOG_PATH_LIMIT = 5;

const SYMLINK_TREE_MODE = "120000";

interface RemoteTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly id: string;
}

export async function undoRejectedFastForward(
  ctx: CloneSyncContext,
  clients: MutatingGitClients,
  worktreeDir: string,
  branch: string,
  headBeforeMerge: string | null,
): Promise<void> {
  await undoRejectedFastForwardIn(ctx, clients.git, worktreeDir, branch, headBeforeMerge);
}

export async function undoRejectedFastForwardIn(
  ctx: FastForwardUndoHost,
  git: SimpleGit,
  worktreeDir: string,
  branch: string,
  headBeforeMerge: string | null,
): Promise<void> {
  if (headBeforeMerge === null) return;
  const headAfterMerge = await readHeadCommit(git);
  if (headAfterMerge === null || headAfterMerge !== headBeforeMerge) return;

  const deviations = await readWorktreeDeviations(ctx, git);
  if (deviations === null) return;
  const dirtyPaths = new Set([...deviations.untracked, ...deviations.modified, ...deviations.missing]);
  if (dirtyPaths.size === 0) return;

  let mergePaths: string[];
  try {
    const output = await git.raw([
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      "HEAD",
      `refs/remotes/origin/${branch}`,
    ]);
    mergePaths = output.split("\0").filter((mergePath) => mergePath.length > 0);
  } catch (error) {
    ctx.logger.warn(
      `Could not list what the rejected fast-forward of '${ctx.repoName}' would have written ` +
        `(${getErrorMessage(error)}); leaving the working tree as it is.`,
    );
    return;
  }

  const candidates = mergePaths.filter((mergePath) => dirtyPaths.has(mergePath));
  if (candidates.length === 0) return;

  const entries = await readRemoteTreeEntries(ctx, git, branch, candidates);
  if (entries === null) return;

  const regularFiles: string[] = [];
  const symlinks: string[] = [];
  const toRemove: string[] = [];
  const toRestore: string[] = [];
  const recordProven = (candidate: string): void => {
    if (deviations.untracked.has(candidate)) {
      toRemove.push(candidate);
    } else {
      toRestore.push(candidate);
    }
  };

  for (const candidate of candidates) {
    if (deviations.missing.has(candidate)) {
      if (!entries.has(candidate)) toRestore.push(candidate);
      continue;
    }
    const kind = await classifyWorktreeEntry(worktreeDir, candidate);
    if (kind === "file") regularFiles.push(candidate);
    else if (kind === "symlink") symlinks.push(candidate);
  }

  const hashes = await hashWorktreeFiles(ctx, git, regularFiles);
  for (const candidate of regularFiles) {
    const entry = entries.get(candidate);
    if (entry?.type !== "blob" || entry.mode === SYMLINK_TREE_MODE) continue;
    if (hashes.get(candidate) !== entry.id) continue;
    recordProven(candidate);
  }

  for (const candidate of symlinks) {
    const entry = entries.get(candidate);
    if (entry?.mode !== SYMLINK_TREE_MODE) continue;
    if (!(await symlinkTargetMatchesBlob(git, worktreeDir, candidate, entry.id))) continue;
    recordProven(candidate);
  }

  const removed = await removeWrittenFiles(ctx, worktreeDir, toRemove);
  const restored = await restoreFilesFromHead(ctx, git, toRestore);
  reportUndoneFastForward(ctx, branch, removed, restored);
}

async function classifyWorktreeEntry(worktreeDir: string, target: string): Promise<"file" | "symlink" | "other"> {
  const stats = await lstatOrNull(path.join(worktreeDir, target));
  if (stats === null) return "other";
  if (stats.isSymbolicLink()) return "symlink";
  return stats.isFile() ? "file" : "other";
}

async function symlinkTargetMatchesBlob(
  git: SimpleGit,
  worktreeDir: string,
  target: string,
  objectId: string,
): Promise<boolean> {
  let linkTarget: string | Buffer;
  try {
    linkTarget = await fs.readlink(path.join(worktreeDir, target));
  } catch {
    return false;
  }
  if (typeof linkTarget !== "string") return false;
  try {
    return (await git.raw(["cat-file", "blob", objectId])) === linkTarget;
  } catch {
    return false;
  }
}

async function readWorktreeDeviations(
  ctx: FastForwardUndoHost,
  git: SimpleGit,
): Promise<{ untracked: Set<string>; modified: Set<string>; missing: Set<string> } | null> {
  try {
    const status = await git.status();
    return {
      untracked: new Set(status.not_added),
      modified: new Set([...status.modified, ...unbucketedTrackedPaths(status)]),
      missing: new Set(status.deleted),
    };
  } catch (error) {
    ctx.logger.warn(
      `Could not read the working tree of '${ctx.repoName}' after the rejected fast-forward ` +
        `(${getErrorMessage(error)}); leaving it as it is.`,
    );
    return null;
  }
}

async function readRemoteTreeEntries(
  ctx: FastForwardUndoHost,
  git: SimpleGit,
  branch: string,
  paths: string[],
): Promise<Map<string, RemoteTreeEntry> | null> {
  const entries = new Map<string, RemoteTreeEntry>();
  for (const batch of inBatches(paths, MERGE_CLEANUP_PATH_BATCH)) {
    let output: string;
    try {
      output = await git.raw(["ls-tree", "-z", `refs/remotes/origin/${branch}`, "--", ...batch.map(asLiteralPathspec)]);
    } catch (error) {
      ctx.logger.warn(
        `Could not read origin/${branch}'s objects for '${ctx.repoName}' after the rejected fast-forward ` +
          `(${getErrorMessage(error)}); leaving the working tree as it is.`,
      );
      return null;
    }
    for (const entry of output.split("\0")) {
      const separator = entry.indexOf("\t");
      if (separator < 0) continue;
      const [mode, type, id] = entry.slice(0, separator).split(" ");
      if (!mode || !type || !id) continue;
      entries.set(entry.slice(separator + 1), { mode, type, id });
    }
  }
  return entries;
}

async function hashWorktreeFiles(
  ctx: FastForwardUndoHost,
  git: SimpleGit,
  paths: string[],
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const batch of inBatches(paths, MERGE_CLEANUP_PATH_BATCH)) {
    const batched = await hashFileBatch(ctx, git, batch);
    if (batched !== null) {
      batch.forEach((batchPath, index) => hashes.set(batchPath, batched[index]));
      continue;
    }
    for (const single of batch) {
      const one = await hashFileBatch(ctx, git, [single]);
      if (one !== null) hashes.set(single, one[0]);
    }
  }
  return hashes;
}

async function hashFileBatch(ctx: FastForwardUndoHost, git: SimpleGit, batch: string[]): Promise<string[] | null> {
  let output: string;
  try {
    output = await git.raw(["hash-object", "--", ...batch]);
  } catch (error) {
    ctx.logger.warn(
      `Could not hash ${batch.length} file(s) in '${ctx.repoName}' after the rejected fast-forward: ` +
        `${summarizeGitFailure(getErrorMessage(error))}`,
    );
    return null;
  }
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== batch.length) {
    ctx.logger.warn(
      `'git hash-object' answered for ${lines.length} of ${batch.length} files in '${ctx.repoName}'; ` +
        `leaving those files as they are.`,
    );
    return null;
  }
  return lines;
}

async function removeWrittenFiles(ctx: FastForwardUndoHost, worktreeDir: string, paths: string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const target of paths) {
    try {
      await fs.rm(path.join(worktreeDir, target), { force: true });
      removed.push(target);
    } catch (error) {
      ctx.logger.warn(`Could not remove '${target}' from '${ctx.repoName}': ${getErrorMessage(error)}`);
    }
  }
  return removed;
}

async function restoreFilesFromHead(ctx: FastForwardUndoHost, git: SimpleGit, paths: string[]): Promise<string[]> {
  const restored: string[] = [];
  for (const batch of inBatches(paths, MERGE_CLEANUP_PATH_BATCH)) {
    try {
      await git.raw(["restore", "--source=HEAD", "--worktree", "--", ...batch.map(asLiteralPathspec)]);
      restored.push(...batch);
    } catch (error) {
      ctx.logger.warn(
        `Could not restore ${batch.length} file(s) in '${ctx.repoName}' from HEAD: ${getErrorMessage(error)}`,
      );
    }
  }
  return restored;
}

function reportUndoneFastForward(
  ctx: FastForwardUndoHost,
  branch: string,
  removed: string[],
  restored: string[],
): void {
  const parts = [describeCleanedPaths("removed", removed), describeCleanedPaths("restored", restored)].filter(
    (part): part is string => part !== null,
  );
  if (parts.length === 0) return;

  const message =
    `↩️  Undid the half-applied fast-forward of '${ctx.repoName}' to origin/${branch}: ${parts.join(", ")}. ` +
    `Each held what origin/${branch} has for that path, or was a path it no longer has.`;
  ctx.logger.info(message);
  ctx.emitProgress({ phase: "merge", message });
}

function describeCleanedPaths(label: string, paths: string[]): string | null {
  if (paths.length === 0) return null;
  const shown = paths.slice(0, MERGE_CLEANUP_LOG_PATH_LIMIT);
  const remaining = paths.length - shown.length;
  const names = remaining > 0 ? `${shown.join(", ")}, +${remaining} more` : shown.join(", ");
  return `${label} ${paths.length} (${names})`;
}
