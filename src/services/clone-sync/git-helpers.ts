import * as fs from "fs/promises";

import type { Stats } from "fs";
import type { SimpleGit } from "simple-git";

// Longest failure summary kept on the incomplete-clone marker's first content
// line; the untruncated message follows it in the same file.
const CLONE_FAILURE_SUMMARY_LIMIT = 200;

// The namespace every remote-tracking ref of this clone lives in, and the
// prefix `git branch -r` strips from a ref to name it (`refs/remotes/origin/x`
// is `origin/x` there).
export const REMOTE_TRACKING_REF_PREFIX = "refs/remotes/";
export const ORIGIN_REF_PREFIX = `${REMOTE_TRACKING_REF_PREFIX}origin/`;

export function getBranchRefspec(branch: string): string {
  return `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
}

// Candidate paths come off `git diff --name-only`, so they are filenames, not
// patterns. Git would read a leading ':' as pathspec magic -- ':userfile.txt'
// matches nothing and `ls-tree` still exits 0, which would turn the deletion
// half's "origin no longer holds it" proof into no proof at all. `:(literal)`
// makes git match the name exactly.
export const asLiteralPathspec = (candidate: string): string => `:(literal)${candidate}`;

export function inBatches(items: readonly string[], limit: number): string[][] {
  // Floored at 1: the callers all pass a positive constant, but a zero or
  // negative one would spin here forever rather than fail, and the narrower
  // helper this replaced could not be called wrongly at all.
  const size = Math.max(1, Math.floor(limit));
  const batches: string[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

// git's stderr condensed to the one line that says why. A clone failure
// carries the whole transfer log — progress lines, separated by carriage
// returns, included — and the verdict is its last 'fatal:'/'error:' line.
export function summarizeGitFailure(message: string): string {
  const lines = message
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const verdict = [...lines].reverse().find((line) => line.startsWith("fatal:") || line.startsWith("error:"));
  const summary = verdict ?? lines[lines.length - 1] ?? "";
  return summary.length > CLONE_FAILURE_SUMMARY_LIMIT
    ? `${summary.slice(0, CLONE_FAILURE_SUMMARY_LIMIT - 3)}...`
    : summary;
}

export function parseLsRemoteHeads(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1] ?? "")
    .filter((ref) => ref.startsWith("refs/heads/"))
    .map((ref) => ref.slice("refs/heads/".length))
    .filter((branch) => branch.length > 0);
}

// Both probes normalize an unusable answer to null rather than passing it
// on: "could not resolve" must never compare equal to another "could not
// resolve" and read as proof that two paths are the same directory.
export async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    const stats: Stats | undefined = await fs.lstat(target);
    return stats ?? null;
  } catch {
    return null;
  }
}

export async function realPathOrNull(target: string): Promise<string | null> {
  try {
    const resolved: string | undefined = await fs.realpath(target);
    return typeof resolved === "string" ? resolved : null;
  } catch {
    return null;
  }
}

export async function readHeadCommit(git: SimpleGit): Promise<string | null> {
  try {
    const head = (await git.raw(["rev-parse", "HEAD"])).trim();
    return head.length > 0 ? head : null;
  } catch {
    return null;
  }
}

export async function readBranchCommit(git: SimpleGit, branch: string): Promise<string | null> {
  try {
    const sha = (await git.raw(["rev-parse", "--verify", `refs/heads/${branch}`])).trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

export async function localBranchExists(git: SimpleGit, branch: string): Promise<boolean> {
  try {
    await git.raw(["show-ref", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export async function hasRemoteBranch(git: SimpleGit, branch: string): Promise<boolean> {
  try {
    // simple-git resolves `show-ref --quiet` even when git exits 1, so keep
    // stdout enabled (no --quiet) to get a real reject on a missing ref —
    // otherwise the post-fetch missing_remote_ref skip would never fire.
    await git.raw(["show-ref", "--verify", `refs/remotes/origin/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export async function isShallowRepository(git: SimpleGit): Promise<boolean> {
  try {
    const output = await git.raw(["rev-parse", "--is-shallow-repository"]);
    return output.trim() === "true";
  } catch {
    return false;
  }
}
