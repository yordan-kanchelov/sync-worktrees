import { getErrorMessage } from "../../utils/errors";

import type { MutatingGitClients } from "./git-clients";
import type { CloneSyncContext } from "./types";
import type { SparseCheckoutConfig } from "../../types";

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
  await (recoveredGit ?? clients.git).raw(lfsSkipped ? ["checkout", "-f", "HEAD"] : ["checkout", "HEAD"]);
}

export type CloneSparseAssessment =
  | { kind: "in-sync" }
  | { kind: "apply"; narrowing: boolean }
  | { kind: "unsafe-narrowing" }
  | { kind: "failed"; error: unknown };

export async function assessSparseCheckout(
  ctx: CloneSyncContext,
  worktreeDir: string,
  cfg: SparseCheckoutConfig,
): Promise<CloneSparseAssessment> {
  const sparseService = ctx.gitService.getSparseCheckoutService();
  try {
    if (!(await sparseService.needsUpdate(worktreeDir, cfg))) return { kind: "in-sync" };

    const currentMode = await sparseService.readCurrentMode(worktreeDir);
    const current = await sparseService.readCurrent(worktreeDir, currentMode);
    const narrowing = sparseService.isNarrowing(
      current,
      sparseService.buildPatterns(cfg),
      currentMode,
      sparseService.resolveMode(cfg),
    );
    if (narrowing && !(await ctx.gitService.checkWorktreeStatus(worktreeDir))) return { kind: "unsafe-narrowing" };
    return { kind: "apply", narrowing };
  } catch (error) {
    return { kind: "failed", error };
  }
}

export async function reapplySparseCheckout(
  ctx: CloneSyncContext,
  worktreeDir: string,
  branch: string,
  cfg: SparseCheckoutConfig,
): Promise<void> {
  const sparseService = ctx.gitService.getSparseCheckoutService();

  try {
    const assessment = await assessSparseCheckout(ctx, worktreeDir, cfg);
    if (assessment.kind === "failed") throw assessment.error;
    if (assessment.kind === "in-sync") return;

    if (assessment.kind === "unsafe-narrowing") {
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

    ctx.emitProgress({ phase: "sparse_checkout", message: `Updating sparse-checkout for '${ctx.repoName}'` });
    await sparseService.applyToWorktree(worktreeDir, cfg);
    ctx.logger.info(`✅ Sparse-checkout updated for '${ctx.repoName}'.`);
    ctx.emitProgress({ phase: "sparse_checkout", message: `Sparse-checkout updated for '${ctx.repoName}'` });
    ctx.outcome?.recordUpdated(branch, worktreeDir, "sparse_checkout");
  } catch (error) {
    ctx.logger.warn(`Failed to reapply sparse-checkout for '${ctx.repoName}': ${getErrorMessage(error)}`);
    ctx.outcome?.recordFailed("sparse-checkout", getErrorMessage(error), {
      reason: "sparse_checkout_failed",
      branch,
      path: worktreeDir,
    });
  }
}
