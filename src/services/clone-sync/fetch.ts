import { getErrorMessage } from "../../utils/errors";
import { isLfsError, isMissingRemoteRefError } from "../../utils/lfs-error";

import { getBranchRefspec, isShallowRepository } from "./git-helpers";

import type { RemoteRelationship } from "../git.service";
import type { MutatingGitClients } from "./git-clients";
import type { CloneSyncContext } from "./types";
import type { SimpleGit } from "simple-git";

const SHALLOW_RELATION_DEEPEN_TARGETS = [50, 200, 1000] as const;

// How far the deepening got, for the two messages that have to say why the
// relationship is still unknown. `null` is "none was attempted at all", which
// happens when the configured depth already sits at or above every target.
export function describeDeepenAttempt(deepenedTo: number | null): string {
  return deepenedTo === null
    ? "no deepening attempted (configured depth already at or above all deepen targets)"
    : `deepening to ${deepenedTo} commits`;
}

// The routine sync fetch keeps a `--depth` cap, ratcheted so it can only ever
// grow: `max(configured depth, the window the clone holds under the ref the
// fetch re-applies it to)`. docs/clone-mode.md carries the user-facing
// measurements, and docs/internal/clone-mode-notes.md the ones behind each
// rule below.
//
// The cap has to stay: `--depth` is what bounds the transfer when the remote
// tip is *not* a descendant of the clone's tip (a force-push or a rebase). A
// shallow clone has no ancestors to offer as `have`s, so uncapped, the server
// packs the new tip's whole ancestry.
//
// Re-sending the *configured* depth is wrong: `git fetch --depth N` re-applies
// N to the ref it fetches rather than capping it, so it would cut back every
// commit the deepen budget bought, every tick. Hence the ratchet, and two
// rules about what it measures:
//
//  - The unit. `--depth N` counts ancestry *levels* from the fetched tip, not
//    commits, so the measurement is measureLocalHistoryDepth's levels, never
//    `rev-list --count` (with or without `--first-parent`), which overshoots
//    on merge-built histories and grows the clone every tick.
//  - The ref. `--depth` is re-applied from the *fetched tip*, so the window is
//    measured under the remote-tracking ref, not HEAD (which lags it on every
//    tick that fetches without merging, and shrinks the window each time) nor
//    the union of the two. HEAD is only the fallback for a first sync that has
//    no such ref yet.
//
// Measured that way the cap is a fixed point — a window `--depth D` produced
// measures back as exactly D — so history widens only when something
// deliberately widens it: the deepen budget, or a raised `depth`. A remote
// that advanced by k levels still slides the window by k, and a local tip a
// force-push moved off the fetched ref's ancestry cannot be held by any depth.
//
// Two edges, both resolved toward keeping a cap:
//   - A non-shallow clone gets no `--depth` at all: the flag would *make* the
//     repository shallow.
//   - If neither walk yields a depth — the remote-tracking ref missing on a
//     first sync, an unborn HEAD, or the empty string simple-git resolves
//     with when git exits non-zero without writing to stderr — the cap falls
//     back to the configured depth rather than to no cap: a re-truncation is
//     something the deepen budget can undo, an uncapped transfer is not.
export async function buildSyncFetchArgs(ctx: CloneSyncContext, git: SimpleGit, branch: string): Promise<string[]> {
  const args = ["origin", "--prune", "--no-tags", "--progress"];
  const depth = await resolveSyncFetchDepth(ctx, git, branch);
  if (depth !== null) {
    args.push("--depth", String(depth));
  }
  args.push(getBranchRefspec(branch));
  return args;
}

async function resolveSyncFetchDepth(ctx: CloneSyncContext, git: SimpleGit, branch: string): Promise<number | null> {
  const configuredDepth = ctx.config.depth;
  if (configuredDepth === undefined) return null;
  if (!(await isShallowRepository(git))) return null;
  const localDepth =
    (await measureLocalHistoryDepth(git, `refs/remotes/origin/${branch}`)) ??
    (await measureLocalHistoryDepth(git, "HEAD"));
  if (localDepth === null) return configuredDepth;
  return Math.max(configuredDepth, localDepth);
}

// The depth the clone holds under `startRef`, in the unit `git fetch --depth`
// uses: one plus the longest shortest-path from that ref to a local commit.
// git assigns a commit the *smallest* number of parent edges that reaches it
// from the tip and cuts the history where that number reaches `--depth`, so
// this is the same measurement read back off the clone.
//
// `rev-list --topo-order` never prints a parent before all of its children,
// so one forward pass over `--parents` output settles every distance: by the
// time a commit is read, every child that could shorten its path has already
// relaxed it. The walk is local and bounded by what the clone holds, and
// grafted boundary commits are printed without parents, so it stops there.
//
// Returns null for anything that is not a usable answer: a rejection (which
// is what an unknown ref gives), and the empty string simple-git resolves
// with when git exits non-zero without writing to stderr.
async function measureLocalHistoryDepth(git: SimpleGit, startRef: string): Promise<number | null> {
  let output: string;
  try {
    output = await git.raw(["rev-list", "--topo-order", "--parents", startRef]);
  } catch {
    return null;
  }

  const depthByCommit = new Map<string, number>();
  let deepest = -1;
  for (const line of output.split("\n")) {
    const ids = line.trim().split(" ");
    const commit = ids[0];
    if (!commit) continue;
    // The first line is the start ref itself, which nothing has relaxed:
    // depth 0.
    const depth = depthByCommit.get(commit) ?? 0;
    if (depth > deepest) deepest = depth;
    for (let i = 1; i < ids.length; i++) {
      const parent = ids[i];
      const known = depthByCommit.get(parent);
      if (known === undefined || known > depth + 1) depthByCommit.set(parent, depth + 1);
    }
  }
  return deepest < 0 ? null : deepest + 1;
}

// The TUI branch switch and the branch wizard's base-branch fetch. Both keep
// `--depth`, and what the flag does here is broader than "bound a branch this
// clone has never seen": it re-applies the configured depth to whatever ref
// it names, and the shallow boundary is repository-wide, so this fetch can
// shorten *or* deepen the clone — including a ref the clone does hold, which
// is the commonest case, since the wizard offers the tracked branch among the
// bases. It does not ratchet like the sync fetch, because the ref it names is
// usually not the one the clone's window was measured over.
//
// The flag stays because dropping it is ruinous for the case it exists for, a
// ref with a tip of its own that the clone has never seen — it costs the
// branch's whole ancestry instead of one commit (docs/clone-mode.md's `depth`
// section has the measurement). Whether it also shortens the tracked branch depends on
// what the ref shares with it, and both callers are about to leave the old
// branch behind anyway: checkoutBranch ends by re-narrowing the remote to the
// new branch and deleting the old origin/* ref.
export async function buildUntrackedBranchFetchArgs(
  ctx: CloneSyncContext,
  git: SimpleGit,
  branch: string,
): Promise<string[]> {
  const args = ["origin", "--prune", "--no-tags", "--progress"];
  if (ctx.config.depth !== undefined && (await isShallowRepository(git))) {
    args.push("--depth", String(ctx.config.depth));
  }
  args.push(getBranchRefspec(branch));
  return args;
}

export function recordMissingRemoteRefSkip(ctx: CloneSyncContext, branch: string): void {
  ctx.recordSkip(
    { kind: "missing_remote_ref", branch, source: "fetch_error" },
    `Tracked branch '${branch}' is missing on remote for '${ctx.repoName}'. Skipping sync.`,
    `Skipping '${ctx.repoName}': origin/${branch} is missing`,
  );
}

export async function fetchWithRecovery(
  ctx: CloneSyncContext,
  clients: MutatingGitClients,
  fetchArgs: string[],
  worktreeDir: string,
  branch: string,
  // checkoutBranch reports its own hard error — recording a "Skipping sync"
  // skip there would double-report a user-initiated action as a sync skip.
  recordSkip = true,
): Promise<{ skipped: boolean }> {
  const recordMissing = (): void => {
    if (recordSkip) recordMissingRemoteRefSkip(ctx, branch);
  };
  try {
    await clients.networkGit.fetch(fetchArgs);
    return { skipped: false };
  } catch (fetchError) {
    const message = getErrorMessage(fetchError);
    if (isLfsError(message)) {
      ctx.logger.info(`⚠️  LFS error during fetch for '${ctx.repoName}'; retrying with LFS disabled.`);
      ctx.emitProgress({ phase: "fetch", message: `Retrying fetch for '${ctx.repoName}' with LFS disabled` });
      const lfsSkipGit = ctx.clients.lfsSkipFetchClient(clients, worktreeDir);
      try {
        await lfsSkipGit.fetch(fetchArgs);
        return { skipped: false };
      } catch (retryError) {
        // The LFS-disabled retry can itself hit a deleted remote branch —
        // classify it as a soft skip too, instead of letting it escape as a
        // hard failure.
        if (isMissingRemoteRefError(getErrorMessage(retryError))) {
          recordMissing();
          return { skipped: true };
        }
        // Otherwise propagate the retry error unchanged so the outer retry
        // policy's LFS handling still sees an accurate error.
        throw retryError;
      }
    }
    if (isMissingRemoteRefError(message)) {
      recordMissing();
      return { skipped: true };
    }
    throw fetchError;
  }
}

export async function unshallowIfDepthRemoved(ctx: CloneSyncContext, clients: MutatingGitClients): Promise<void> {
  if (ctx.config.depth !== undefined) return;

  if (!(await isShallowRepository(clients.git))) return;

  ctx.logger.info(
    `[deepen] Existing shallow clone for '${ctx.repoName}' has no configured depth; fetching full history...`,
  );
  ctx.emitProgress({ phase: "fetch", message: `Fetching full history for '${ctx.repoName}'` });
  // `--progress` is what keeps simple-git's inactivity timer alive across the
  // transfer: it only resets on stdout/stderr data, and with stderr piped git
  // suppresses every transfer and delta line and asks the server for
  // `no-progress`. simple-git's progress plugin would append the flag to any
  // `fetch` anyway; spelling it out keeps the argv ours rather than the
  // plugin's, and matches every other fetch here.
  await clients.unshallowGit.fetch(["--unshallow", "--no-tags", "--progress"]);
}

export function getDeepenTargets(ctx: CloneSyncContext): readonly number[] {
  const configuredDepth = ctx.config.depth;
  if (configuredDepth === undefined) return [];
  // `git fetch --depth N` can shorten a shallow repo if N is below current depth.
  // Skip targets at or below the configured depth — they would never widen history.
  // Note the direction this gives `depth`: raising it can only *remove*
  // targets, and a depth at or above the largest one leaves no budget at all.
  // The sync fetch's ratcheted cap does widen a shorter clone toward a raised
  // `depth` (it takes the larger of the two), but it cannot go past it, so
  // once a clone is at `depth` and still unclassifiable the only remedy left
  // is removing `depth`, which unshallows via unshallowIfDepthRemoved.
  return SHALLOW_RELATION_DEEPEN_TARGETS.filter((target) => target > configuredDepth);
}

async function deepenShallowHistoryToDepth(
  ctx: CloneSyncContext,
  clients: MutatingGitClients,
  branch: string,
  targetDepth: number,
): Promise<void> {
  ctx.logger.info(
    `[deepen] Shallow clone for '${ctx.repoName}' lacks enough history to classify origin/${branch}; ` +
      `refetching to depth ${targetDepth} before deciding.`,
  );
  ctx.emitProgress({
    phase: "fetch",
    message: `Deepening '${ctx.repoName}' to depth ${targetDepth} before classifying origin/${branch}`,
  });
  await clients.networkGit.fetch([
    "origin",
    "--depth",
    String(targetDepth),
    "--prune",
    "--no-tags",
    "--progress",
    getBranchRefspec(branch),
  ]);
}

// The relationship classification both the sync tick and the branch switch
// decide on, with the deepening budget both are allowed to spend on it. A
// shallow clone can be too short to answer at all: the `--depth N` clone cut
// history under a tip the remote has since moved more than N commits past, so
// merge-base has nothing to walk and the classifier says
// `indeterminate_shallow` rather than guessing. Each target is fetched in
// turn and the first decisive answer wins, so the common case costs one extra
// fetch and only a genuinely unrelated history spends the whole budget.
//
// `localRef` names the local side: the tick asks about HEAD (its default),
// the branch switch about a branch it has not switched to yet.
export async function classifyWithDeepening(
  ctx: CloneSyncContext,
  clients: MutatingGitClients,
  worktreeDir: string,
  branch: string,
  localRef?: string,
): Promise<{ relationship: RemoteRelationship; deepenedTo: number | null; deepenFetches: number }> {
  let relationship = await ctx.gitService.classifyRemoteRelationship(worktreeDir, branch, localRef);
  if (relationship !== "indeterminate_shallow") return { relationship, deepenedTo: null, deepenFetches: 0 };

  let deepenedTo: number | null = null;
  // `deepenedTo` says how deep the budget got, which is what the skip
  // messages need; `deepenFetches` says how many fetches that took, which is
  // what the tick's timing table counts.
  let deepenFetches = 0;
  for (const target of getDeepenTargets(ctx)) {
    await deepenShallowHistoryToDepth(ctx, clients, branch, target);
    deepenedTo = target;
    deepenFetches++;
    relationship = await ctx.gitService.classifyRemoteRelationship(worktreeDir, branch, localRef);
    if (relationship !== "indeterminate_shallow") break;
  }
  return { relationship, deepenedTo, deepenFetches };
}
