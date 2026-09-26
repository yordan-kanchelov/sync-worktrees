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

// The two keys configureSingleBranchRemote converges, as one `git config
// --get-regexp` pattern so reading them costs a single git process. Anchored
// so it matches those two keys and nothing that merely contains them.
const REMOTE_ORIGIN_CONFIG_KEY_PATTERN = "^remote\\.origin\\.(fetch|tagOpt)$";

// How many remote-tracking refs one `git branch -r -D` names while the stale
// ones a wider refspec left behind are swept. A legacy all-branches clone of a
// busy repository holds thousands of them; the bound exists only so one
// command line fits the platform's argument limit.
const STALE_REF_DELETE_BATCH = 200;

// The single-branch shape every clone-mode remote is held to: one fetch
// refspec naming the tracked branch, tags off, and no remote-tracking ref
// besides that branch's. Init, the branch switch and every sync tick call
// it, and it writes only what is not already that shape.
//
// It has to read first because `git config --replace-all` is not a no-op on
// an unchanged value: it renames a fresh config.lock over .git/config, so
// the file lands on a new inode and mtime every time (git 2.43). On a tick
// that is churn for nothing — the sync fetch carries its refspec on the
// command line (buildSyncFetchArgs), and the one fetch that reads the stored
// one, the `--unshallow`, runs before this call.
//
// It stays in the tick rather than moving to init for the reason the origin
// URL is re-checked there: a daemon holds one clone for weeks, and `git
// remote set-branches --all` or an editor is enough to widen a refspec that
// was converged at adoption.
export async function configureSingleBranchRemote(
  ctx: CloneSyncContext,
  clients: MutatingGitClients,
  branch: string,
  options: { sweepStaleRefs?: "always" } = {},
): Promise<void> {
  const refspec = getBranchRefspec(branch);
  const { refspecConverged, tagOptConverged } = await assessSingleBranchRemote(clients.git, branch);

  // Stale refs are what a wide refspec fetched, so they are swept on the
  // call that narrows it — and before that write, not after: the two are not
  // one operation, and this order leaves a kill in between with the wide
  // refspec that makes the next call redo both. The other order leaves a
  // narrow refspec with stale refs behind it, which reads as converged and
  // would never be swept.
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

// The read half of configureSingleBranchRemote: whether origin already has
// the single-branch shape, so `sync --dry-run` can say a sync would narrow it.
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

// Both keys in one spawn, as `key\nvalue` records separated by NUL. The
// caller treats anything this cannot positively prove as drift, and that is
// the whole design: `git config` reports a key it does not hold with exit
// code 1 and an empty stderr, and simple-git fails a task only when the exit
// code is non-zero AND stderr is non-empty, so "unset" arrives as the empty
// string — exactly like a read that failed silently. Believing such an
// answer would skip the write forever and leave the clone un-narrowed, which
// is worse than the churn this replaces; reading wrong costs one redundant
// write.
//
// `--local` is the scope `--replace-all` writes to, so the read answers
// about the file the write would change; a value inherited from ~/.gitconfig
// is left to git to merge, as before. `-z` keeps a value containing a
// newline from forging a second entry.
async function readRemoteConfigValues(git: SimpleGit): Promise<Map<string, string[]> | null> {
  // The parse is inside the guard with the spawn: this function's contract is
  // that it fails to null and the caller then writes, so a surprise from the
  // parse (a raw that is not a string, from a double or a future simple-git)
  // must not escape and fail the whole tick from the one place built to fail
  // safe.
  try {
    const raw = await git.raw(["config", "--local", "-z", "--get-regexp", REMOTE_ORIGIN_CONFIG_KEY_PATTERN]);
    const values = new Map<string, string[]>();
    for (const record of raw.split("\0")) {
      if (record.length === 0) continue;
      const separator = record.indexOf("\n");
      // git lower-cases the key it prints, and a key set without a value is
      // printed on its own with no newline after it.
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
  } catch {
    // Stale remote refs are best-effort cleanup; sync correctness comes from the narrowed refspec.
  }
}

// The refs a wider refspec left behind, swept where the `for-each-ref` can
// find something: on the call that narrows the refspec, and on adoption,
// where the clone came from outside and nothing is known about its refs. A
// tick over an already-narrowed clone does not sweep — its fetch is
// `--prune` with an explicit single-branch refspec, which can neither create
// nor prune any other origin/* ref, so the only refs a sweep could find
// there arrived out of band.
//
// The deletion is batched through `git branch -r -D` rather than
// `update-ref --stdin`: the latter is one transaction that a single locked
// ref aborts with nothing deleted, and simple-git cannot feed a child's stdin
// without bypassing the client factory and the primary-checkout guard.
// docs/internal/clone-mode-notes.md has the detail.
//
// `git branch -r` addresses a ref by the part after 'refs/remotes/', so the
// refs are filtered on that exact prefix and only ever shortened, never
// rebuilt: nothing outside `refs/remotes/origin/` can be named, and a name
// shortened this way always starts with 'origin/' and so can never be read
// as an option.
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
      // How much of a refused batch git deleted is version-dependent (all but
      // the locked ref on git 2.43, none on 2.55), so neither answer can be
      // relied on. A refused batch is retried one ref at a time: the per-ref
      // cost, paid only on the batch that failed, and it leaves exactly the
      // refs git genuinely refuses.
      ctx.logger.debug(
        `A batch of ${batch.length} stale remote-tracking ref(s) in '${ctx.repoName}' was refused; ` +
          `retrying them one at a time: ${summarizeGitFailure(getErrorMessage(error))}`,
      );
      for (const name of batch) {
        try {
          await clients.git.raw(["branch", "-r", "-D", name]);
        } catch {
          // The ref git actually refuses. Left in place: it is stale
          // cleanup, and the narrowed refspec already keeps it out of every
          // fetch.
        }
      }
    }
  }
}

// Detects an on-disk clone whose `origin` no longer matches the configured
// repoUrl (e.g. repoUrl was repointed in config). Returns a skip descriptor so
// we never fetch/ff-merge from the wrong remote; null when origin matches or
// can't be read. Comparison is normalized so https/.git/trailing-slash
// variants don't false-positive; the URLs are kept in the message and skip
// descriptor with any embedded credentials stripped (both can carry one).
export async function evaluateOriginMatch(
  ctx: CloneSyncContext,
  git: SimpleGit,
  worktreeDir: string,
): Promise<CloneSkipDescriptor | null> {
  let originUrl: string;
  try {
    originUrl = (await git.raw(["remote", "get-url", "origin"])).trim();
  } catch {
    ctx.logger.warn(`Could not read 'origin' remote URL from existing clone at '${worktreeDir}'.`);
    return null;
  }

  if (!originUrl || normalizeRepoUrlForComparison(originUrl) === normalizeRepoUrlForComparison(ctx.config.repoUrl)) {
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
