import * as fs from "fs/promises";
import * as path from "path";

import { getErrorMessage } from "../../utils/errors";

import { asLiteralPathspec, inBatches, lstatOrNull, readHeadCommit, summarizeGitFailure } from "./git-helpers";

import type { MutatingGitClients } from "./git-clients";
import type { CloneSyncContext } from "./types";
import type { SimpleGit } from "simple-git";

// Paths handed to one `ls-tree` / `hash-object` / `restore` while a rejected
// fast-forward is being undone. The set is usually a handful of files — the
// ones that sort before the path git could not write — but an upstream commit
// whose failing path sorts last leaves every changed file behind, and one
// command line still has to fit the platform's argument limit.
const MERGE_CLEANUP_PATH_BATCH = 200;

// How many of those paths the summary line names before it starts counting.
const MERGE_CLEANUP_LOG_PATH_LIMIT = 5;

// `ls-tree`'s mode for a symlink, whose blob holds the target path rather than
// any file's contents.
const SYMLINK_TREE_MODE = "120000";

interface RemoteTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly id: string;
}

// A `merge --ff-only` git rejects is not a no-op. Its checkout half walks the
// index in path order and stops at the first entry it cannot write — a
// missing LFS object is the usual reason — with everything that sorts before
// that path already updated on disk and the index and HEAD still describing
// the old commit. `git status` then reports those paths, so the next tick
// soft-skips with dirty_tree at info level and exits 0, and so does every
// tick after it: git refuses to overwrite the untracked files the first
// attempt left, which makes even a fixed LFS server unable to end the loop.
// Undoing the half-applied checkout is what keeps the next attempt — and the
// next tick — able to run at all.
//
// What makes that safe is not that the tree was clean a moment earlier: the
// merge itself sits between that check and this point on a sync tick, and a
// branch switch adds the unshallow, the branch fetch, the relationship
// classification with up to three deepening fetches and the switch on top —
// together they can run for minutes. Each path is proved on its own instead,
// against what origin/<branch> holds for it:
//
//   present on disk — removed or restored only when its contents are what
//     that ref holds for that path. Whoever put them there, they are the
//     incoming version, and the next successful fast-forward writes that
//     same object back — so undoing it loses nothing origin does not hold.
//   missing from disk — restored only when that ref does NOT hold the path,
//     the one case where the merge is what deleted it. A path origin still
//     carries went missing some other way, and stays missing.
//   anything else — left exactly as it is, dirty_tree and all.
//
// Deliberately not gated on the failure being a checkout failure: a merge
// can also fail on `index.lock` while somebody's own git command dirties the
// tree, and the per-path proof above is what decides there too — their work
// does not match the incoming version, so none of it is touched.
export async function undoRejectedFastForward(
  ctx: CloneSyncContext,
  clients: MutatingGitClients,
  worktreeDir: string,
  branch: string,
  headBeforeMerge: string | null,
): Promise<void> {
  // Both halves fail closed. Without a before-and-after commit there is no
  // proof the merge left HEAD alone, and a merge that did move HEAD wrote
  // those files on purpose — undoing them would delete the update.
  if (headBeforeMerge === null) return;
  const headAfterMerge = await readHeadCommit(clients.git);
  if (headAfterMerge === null || headAfterMerge !== headBeforeMerge) return;

  const deviations = await readWorktreeDeviations(ctx, clients.git);
  if (deviations === null) return;
  const dirtyPaths = new Set([...deviations.untracked, ...deviations.modified, ...deviations.missing]);
  if (dirtyPaths.size === 0) return;

  // Only paths this merge would have written are candidates; a dirty path
  // outside that set is somebody's own work and is never touched.
  let mergePaths: string[];
  try {
    const output = await clients.git.raw(["diff", "--name-only", "-z", "HEAD", `refs/remotes/origin/${branch}`]);
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

  // Read for every candidate, not just the ones still on disk: a path's
  // ABSENCE from this map is the proof that lets a missing file be restored,
  // so a lookup that failed must abort the whole cleanup rather than read as
  // "origin does not have it".
  const entries = await readRemoteTreeEntries(ctx, clients.git, branch, candidates);
  if (entries === null) return;

  // git writes a regular file or a symlink and nothing else, and the two are
  // proved differently — `hash-object` follows a symlink and hashes whatever
  // is at the other end, which never equals the blob git stores for it (the
  // target path) and would read a file outside the repository besides.
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

  const hashes = await hashWorktreeFiles(ctx, clients.git, regularFiles);
  for (const candidate of regularFiles) {
    const entry = entries.get(candidate);
    // A symlink is a blob as well, so the mode has to be excluded here: a
    // regular file whose content happens to be the link target string would
    // otherwise prove equal to a symlink origin holds at that path.
    if (entry?.type !== "blob" || entry.mode === SYMLINK_TREE_MODE) continue;
    if (hashes.get(candidate) !== entry.id) continue;
    recordProven(candidate);
  }

  for (const candidate of symlinks) {
    const entry = entries.get(candidate);
    if (entry?.mode !== SYMLINK_TREE_MODE) continue;
    if (!(await symlinkTargetMatchesBlob(clients.git, worktreeDir, candidate, entry.id))) continue;
    recordProven(candidate);
  }

  const removed = await removeWrittenFiles(ctx, clients, worktreeDir, toRemove);
  const restored = await restoreFilesFromHead(ctx, clients, toRestore);
  reportUndoneFastForward(ctx, branch, removed, restored);
}

// What is at `target` right now, without following it: a symlink git wrote
// must be recognized as one, and a path that turned into a directory or
// vanished under us is left alone.
async function classifyWorktreeEntry(worktreeDir: string, target: string): Promise<"file" | "symlink" | "other"> {
  const stats = await lstatOrNull(path.join(worktreeDir, target));
  if (stats === null) return "other";
  if (stats.isSymbolicLink()) return "symlink";
  return stats.isFile() ? "file" : "other";
}

// git stores a symlink as a blob holding the target path, so that string is
// what has to match — `cat-file` gives it verbatim, with no trailing newline
// for `readlink` to differ by.
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

// Every working-tree deviation git reports, split the way the cleanup has to
// treat them. Paths a sparse checkout leaves out never appear here — git
// does not report a skip-worktree entry as deleted — so the cleanup cannot
// try to materialize a path outside the cone.
async function readWorktreeDeviations(
  ctx: CloneSyncContext,
  git: SimpleGit,
): Promise<{ untracked: Set<string>; modified: Set<string>; missing: Set<string> } | null> {
  try {
    const status = await git.status();
    return {
      untracked: new Set(status.not_added),
      modified: new Set(status.modified),
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

// What origin/<branch> holds for each path — mode, type and object id.
// `ls-tree` reports only the paths that exist in that tree and skips the
// rest, which is exactly the answer the deletion half needs.
async function readRemoteTreeEntries(
  ctx: CloneSyncContext,
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

// What each regular file currently holds, hashed by git itself so the
// repository's filters (LFS's clean filter, CRLF conversion) are applied the
// way they were when the blob was made. A path missing from the result is
// one nothing may be concluded about, so it is simply never acted on.
async function hashWorktreeFiles(ctx: CloneSyncContext, git: SimpleGit, paths: string[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const batch of inBatches(paths, MERGE_CLEANUP_PATH_BATCH)) {
    const batched = await hashFileBatch(ctx, git, batch);
    if (batched !== null) {
      batch.forEach((batchPath, index) => hashes.set(batchPath, batched[index]));
      continue;
    }
    // One unreadable path fails the whole invocation, and failing the run
    // over it would leave the wedge this cleanup exists to remove. Ask again
    // per path so a file that cannot be hashed disqualifies itself and
    // nothing else.
    for (const single of batch) {
      const one = await hashFileBatch(ctx, git, [single]);
      if (one !== null) hashes.set(single, one[0]);
    }
  }
  return hashes;
}

// `hash-object` prints one line per input, in order; anything else means the
// mapping cannot be trusted and the caller falls back to asking one at a
// time. Only the summary line of a failure is logged: simple-git puts the
// command's stdout in the error, which here is the hashes it did print.
async function hashFileBatch(ctx: CloneSyncContext, git: SimpleGit, batch: string[]): Promise<string[] | null> {
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

// `_clients` is unused on purpose and must stay, for the reason
// CloneGitClients.lfsSkipCheckoutClient gives: this deletes files from the
// working tree, and requiring the brand is what keeps that behind the
// primary-checkout guard.
async function removeWrittenFiles(
  ctx: CloneSyncContext,
  _clients: MutatingGitClients,
  worktreeDir: string,
  paths: string[],
): Promise<string[]> {
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

// `restore --worktree` rather than `checkout HEAD --`: the rejected merge
// left the index alone, so putting these files back is a working-tree edit
// and nothing else. It also keeps the pathspec clear of simple-git's
// progress plugin, which appends `--progress` to every `checkout` — after a
// `--` git reads that as one more path to restore.
async function restoreFilesFromHead(
  ctx: CloneSyncContext,
  clients: MutatingGitClients,
  paths: string[],
): Promise<string[]> {
  const restored: string[] = [];
  for (const batch of inBatches(paths, MERGE_CLEANUP_PATH_BATCH)) {
    try {
      await clients.git.raw(["restore", "--source=HEAD", "--worktree", "--", ...batch.map(asLiteralPathspec)]);
      restored.push(...batch);
    } catch (error) {
      // A restore can fail for the same reason the merge did — HEAD's own
      // version of the path may need the smudge filter that is down. The
      // tree is then no worse than it was, and the next tick reports it.
      ctx.logger.warn(
        `Could not restore ${batch.length} file(s) in '${ctx.repoName}' from HEAD: ${getErrorMessage(error)}`,
      );
    }
  }
  return restored;
}

function reportUndoneFastForward(ctx: CloneSyncContext, branch: string, removed: string[], restored: string[]): void {
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
