import { getErrorMessage } from "../../utils/errors";
import { normalizeRepoUrlForComparison, redactRepoUrl } from "../../utils/git-url";

import {
  ORIGIN_REF_PREFIX,
  REMOTE_TRACKING_REF_PREFIX,
  getBranchRefspec,
  inBatches,
  summarizeGitFailure,
} from "./git-helpers";

import type { MutatingGitClients } from "./git-clients";
import type { CloneSkipDescriptor, CloneSyncContext } from "./types";
import type { SimpleGit } from "simple-git";

const REMOTE_ORIGIN_CONFIG_KEY_PATTERN = "^remote\\.origin\\.(fetch|tagOpt)$";

const STALE_REF_DELETE_BATCH = 200;

export async function configureSingleBranchRemote(
  ctx: CloneSyncContext,
  clients: MutatingGitClients,
  branch: string,
  options: { sweepStaleRefs?: "always" } = {},
): Promise<void> {
  const refspec = getBranchRefspec(branch);
  const { refspecConverged, tagOptConverged } = await assessSingleBranchRemote(clients.git, branch);

  if (!refspecConverged || options.sweepStaleRefs === "always") {
    await deleteStaleRemoteTrackingRefs(ctx, clients, branch);
  }
  if (!refspecConverged) {
    await clients.git.raw(["config", "--replace-all", "remote.origin.fetch", refspec]);
  }
  if (!tagOptConverged) {
    await clients.git.raw(["config", "--replace-all", "remote.origin.tagOpt", "--no-tags"]);
  }
}

export async function assessSingleBranchRemote(
  git: SimpleGit,
  branch: string,
): Promise<{ refspecConverged: boolean; tagOptConverged: boolean }> {
  const current = await readRemoteConfigValues(git);
  const holds = (key: string, value: string): boolean => {
    const values = current?.get(key);
    return values !== undefined && values.length === 1 && values[0] === value;
  };
  return {
    refspecConverged: holds("remote.origin.fetch", getBranchRefspec(branch)),
    tagOptConverged: holds("remote.origin.tagopt", "--no-tags"),
  };
}

async function readRemoteConfigValues(git: SimpleGit): Promise<Map<string, string[]> | null> {
  try {
    const raw = await git.raw(["config", "--local", "-z", "--get-regexp", REMOTE_ORIGIN_CONFIG_KEY_PATTERN]);
    const values = new Map<string, string[]>();
    for (const record of raw.split("\0")) {
      if (record.length === 0) continue;
      const separator = record.indexOf("\n");
      const key = (separator === -1 ? record : record.slice(0, separator)).toLowerCase();
      const value = separator === -1 ? "" : record.slice(separator + 1);
      const existing = values.get(key);
      if (existing) existing.push(value);
      else values.set(key, [value]);
    }
    return values;
  } catch {
    return null;
  }
}

export async function deleteRemoteTrackingRef(clients: MutatingGitClients, refName: string): Promise<void> {
  try {
    await clients.git.raw(["update-ref", "-d", refName]);
  } catch {}
}

async function deleteStaleRemoteTrackingRefs(
  ctx: CloneSyncContext,
  clients: MutatingGitClients,
  branch: string,
): Promise<void> {
  let refsOutput: string;
  try {
    refsOutput = await clients.git.raw(["for-each-ref", "--format=%(refname)", "refs/remotes/origin"]);
  } catch {
    return;
  }

  const keepRef = `${ORIGIN_REF_PREFIX}${branch}`;
  const namesToDelete = refsOutput
    .split(/\r?\n/)
    .map((ref) => ref.trim())
    .filter((ref) => ref.startsWith(ORIGIN_REF_PREFIX) && ref !== keepRef && ref !== `${ORIGIN_REF_PREFIX}HEAD`)
    .map((ref) => ref.slice(REMOTE_TRACKING_REF_PREFIX.length));

  for (const batch of inBatches(namesToDelete, STALE_REF_DELETE_BATCH)) {
    try {
      await clients.git.raw(["branch", "-r", "-D", ...batch]);
    } catch (error) {
      ctx.logger.debug(
        `A batch of ${batch.length} stale remote-tracking ref(s) in '${ctx.repoName}' was refused; ` +
          `retrying them one at a time: ${summarizeGitFailure(getErrorMessage(error))}`,
      );
      for (const name of batch) {
        try {
          await clients.git.raw(["branch", "-r", "-D", name]);
        } catch {}
      }
    }
  }
}

export async function evaluateOriginMatch(
  ctx: CloneSyncContext,
  git: SimpleGit,
  worktreeDir: string,
): Promise<CloneSkipDescriptor | null> {
  let originUrl = "";
  try {
    originUrl = (await git.raw(["config", "--local", "--get", "remote.origin.url"])).trim();
  } catch {}
  if (!originUrl) {
    ctx.logger.warn(`Could not read 'origin' remote URL from existing clone at '${worktreeDir}'.`);
    return null;
  }

  if (normalizeRepoUrlForComparison(originUrl) === normalizeRepoUrlForComparison(ctx.config.repoUrl)) {
    return null;
  }

  const actual = redactRepoUrl(originUrl);
  const expected = redactRepoUrl(ctx.config.repoUrl);
  return {
    skip: { kind: "origin_mismatch", actual, expected },
    warnMessage:
      `Existing clone at '${worktreeDir}' has origin '${actual}', expected '${expected}'. ` +
      `Update the remote ('git remote set-url origin <url>') or point worktreeDir at a fresh path.`,
    progressDetail: `origin '${actual}' is not '${expected}'`,
  };
}
