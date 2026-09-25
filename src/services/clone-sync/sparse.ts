import { getErrorMessage } from "../../utils/errors";

import type { MutatingGitClients } from "./git-clients";
import type { CloneSyncContext } from "./types";
import type { SparseCheckoutConfig } from "../../types";

// The initial narrowing of a fresh clone, and its re-run when init finds a
// clone of its own that was interrupted before finishing. `sparse-checkout
// set` then the trailing `checkout HEAD` that materializes the cone.
//
// `lfsSkipped` is set when the clone's own checkout only succeeded with LFS
// smudging forced off. Both halves then run with that same environment:
// `sparse-checkout set` materializes everything the cone brings in, so with
// the configured one it would smudge the objects the retry skipped and die
// exactly as the clone did — leaving a half-narrowed tree that `git status`
// calls clean and the next run adopts. Otherwise the sparse service keeps its
// own factory, whose clients already carry the configured LFS setting.
export async function applySparseCheckoutAfterClone(
  ctx: CloneSyncContext,
  clients: MutatingGitClients,
  worktreeDir: string,
  cfg: SparseCheckoutConfig,
  lfsSkipped: boolean,
): Promise<void> {
  const sparseService = ctx.gitService.getSparseCheckoutService();
  const recoveredGit = lfsSkipped ? ctx.clients.lfsSkipCheckoutClient(clients, worktreeDir) : undefined;
  await sparseService.applyToWorktree(worktreeDir, cfg, recoveredGit);
  await (recoveredGit ?? clients.git).raw(["checkout", "HEAD"]);
}

// Reconciles the clone's sparse patterns with the config, the same three
// steps worktree mode runs over every worktree it manages: is an update
// needed, is that update a narrowing one, and is the tree clean enough to
// take it.
//
// `sparse-checkout set` writes core.sparseCheckout to the repository config,
// so it is a mutation too — it takes a path, not a client, and stays correct
// only because the primary-checkout guard in the caller already ran.
export async function reapplySparseCheckout(
  ctx: CloneSyncContext,
  worktreeDir: string,
  branch: string,
  cfg: SparseCheckoutConfig,
): Promise<void> {
  const sparseService = ctx.gitService.getSparseCheckoutService();

  try {
    if (!(await sparseService.needsUpdate(worktreeDir, cfg))) return;

    // Narrowing drops paths out of the cone, and git then has to decide what
    // to do with whatever the user left in them. It keeps modified, staged
    // and untracked files: they stay on disk, and git warns about it on its
    // own stderr, which simple-git captures and this tool never prints — so
    // the preservation is real but silent. This gate is therefore not what
    // stands between the user and data loss — docs/sparse-checkout.md's
    // "Narrowing safety" section is the tool's promise to skip rather than
    // git's promise to preserve, and worktree mode has always kept it. The
    // deferred narrowing lands on the first tick that finds a clean tree.
    const current = await sparseService.readCurrent(worktreeDir);
    if (sparseService.isNarrowing(current, sparseService.buildPatterns(cfg))) {
      // The same notion of "clean" the ff-merge gate uses: uncommitted and
      // untracked changes. Unpushed commits are a clone-mode skip of their
      // own and their content is safe in the object store either way.
      if (!(await ctx.gitService.checkWorktreeStatus(worktreeDir))) {
        const message = "working tree has local changes";
        ctx.logger.warn(`⏭️  Skipping sparse-checkout narrowing for '${ctx.repoName}' — ${message}.`);
        ctx.emitProgress({
          phase: "sparse_checkout",
          message: `Skipping sparse-checkout narrowing for '${ctx.repoName}': ${message}`,
        });
        ctx.outcome?.recordSkipped("sparse-checkout", "sparse_narrowing_unsafe", {
          branch,
          path: worktreeDir,
          message,
        });
        return;
      }
    }

    ctx.emitProgress({ phase: "sparse_checkout", message: `Updating sparse-checkout for '${ctx.repoName}'` });
    await sparseService.applyToWorktree(worktreeDir, cfg);
    ctx.emitProgress({ phase: "sparse_checkout", message: `Sparse-checkout updated for '${ctx.repoName}'` });
  } catch (error) {
    // Not fatal — the fetch and merge after it are what the sync is for, and
    // a stale pattern list does not block them. But it is recorded: warning
    // and exiting 0 on every tick is how a sparse config that git rejects
    // stays broken for weeks, because nothing watching the run ever learns.
    ctx.logger.warn(`Failed to reapply sparse-checkout for '${ctx.repoName}': ${getErrorMessage(error)}`);
    ctx.outcome?.recordFailed("sparse-checkout", getErrorMessage(error), {
      reason: "sparse_checkout_failed",
      branch,
      path: worktreeDir,
    });
  }
}
