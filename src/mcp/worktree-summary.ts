import simpleGit from "simple-git";

import type { WorktreeStatusResult } from "../services/worktree-status.service";

export type WorktreeLabel = "current" | "dirty" | "stale" | "clean" | "unknown";

export interface Divergence {
  ahead: number;
  behind: number;
}

export interface SafeToRemove {
  safe: boolean;
  reason: string;
}

export function deriveLabel(status: WorktreeStatusResult, isCurrent: boolean): WorktreeLabel {
  if (isCurrent) return "current";
  if (!status.isClean || status.hasUnpushedCommits || status.hasStashedChanges) return "dirty";
  if (status.upstreamGone) return "stale";
  return "clean";
}

export function deriveSafeToRemove(status: WorktreeStatusResult): SafeToRemove {
  const safe = status.canRemove && !status.upstreamGone;

  if (safe) {
    return {
      safe: true,
      reason: status.upstreamGone
        ? "branch deleted upstream, clean tree, no unpushed commits"
        : "clean tree, no unpushed commits",
    };
  }

  if (status.upstreamGone && status.canRemove) {
    return {
      safe: false,
      reason: "branch deleted upstream — verify no work is lost before removal",
    };
  }

  if (status.reasons.length > 0) {
    return { safe: false, reason: status.reasons.join(", ") };
  }

  return { safe: false, reason: "not safe to remove" };
}

export async function getDivergence(worktreePath: string): Promise<Divergence | null> {
  try {
    const git = simpleGit(worktreePath);
    const output = await git.raw(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    const [aheadStr, behindStr] = output.trim().split(/\s+/);
    return { ahead: parseInt(aheadStr, 10), behind: parseInt(behindStr, 10) };
  } catch {
    return null;
  }
}
