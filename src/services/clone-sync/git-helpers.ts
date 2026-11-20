import * as fs from "fs/promises";

import type { Stats } from "fs";
import type { SimpleGit } from "simple-git";

const CLONE_FAILURE_SUMMARY_LIMIT = 200;

export const REMOTE_TRACKING_REF_PREFIX = "refs/remotes/";
export const ORIGIN_REF_PREFIX = `${REMOTE_TRACKING_REF_PREFIX}origin/`;

export function getBranchRefspec(branch: string): string {
  return `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
}

export const asLiteralPathspec = (candidate: string): string => `:(literal)${candidate}`;

export function inBatches(items: readonly string[], limit: number): string[][] {
  const size = Math.max(1, Math.floor(limit));
  const batches: string[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

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
