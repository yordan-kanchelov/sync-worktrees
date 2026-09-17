import type { WorktreeStatusResult } from "../services/worktree-status.service";

export type WorktreeLabel = "current" | "dirty" | "stale" | "clean" | "unknown";

/** Ahead/behind against `@{upstream}`, as {@link WorktreeStatusResult.divergence} reports it. */
export type Divergence = NonNullable<WorktreeStatusResult["divergence"]>;

export interface SafeToRemove {
  safe: boolean;
  reason: string;
}

export function deriveLabel(status: WorktreeStatusResult, isCurrent: boolean): WorktreeLabel {
  if (isCurrent) return "current";
  const unpushedBlocks = status.hasUnpushedCommits && !status.fullyPushedUpstreamDeleted;
  if (!status.isClean || unpushedBlocks || status.hasStashedChanges) return "dirty";
  if (status.upstreamGone || status.fullyPushedUpstreamDeleted) return "stale";
  return "clean";
}

export function deriveSafeToRemove(status: WorktreeStatusResult): SafeToRemove {
  if (status.canRemove && status.fullyPushedUpstreamDeleted) {
    return { safe: true, reason: "fully pushed before its remote branch was deleted" };
  }

  if (status.canRemove && !status.upstreamGone) {
    return { safe: true, reason: "clean tree, no unpushed commits" };
  }

  if (status.canRemove && status.upstreamGone) {
    return { safe: false, reason: "branch deleted upstream — verify no work is lost before removal" };
  }

  if (status.reasons.length > 0) {
    return { safe: false, reason: status.reasons.join(", ") };
  }

  return { safe: false, reason: "not safe to remove" };
}
