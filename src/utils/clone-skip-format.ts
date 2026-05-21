import type { CloneSkipReason } from "../services/clone-sync.service";

export function formatCloneSkipReason(reason: CloneSkipReason): string {
  switch (reason.kind) {
    case "branch_mismatch":
      return reason.phase === "init"
        ? `clone is on '${reason.currentBranch}', expected '${reason.expectedBranch}' (since process start)`
        : `clone is on '${reason.currentBranch}', expected '${reason.expectedBranch}'`;
    case "head_unreadable":
      return `could not read HEAD: ${reason.error}`;
    case "dirty_tree":
      return `working tree has local changes`;
    case "diverged":
      return `diverged from origin/${reason.branch}`;
    case "ahead_unpushed":
      return `unpushed commits ahead of origin/${reason.branch}`;
    case "missing_remote_ref":
      return reason.source === "fetch_error"
        ? `origin/${reason.branch} missing on remote (fetch error)`
        : `origin/${reason.branch} pruned after fetch`;
    case "indeterminate_shallow":
      return `unable to classify origin/${reason.branch} after deepening shallow history to ${reason.deepenedTo} commits — remove or raise 'depth' to unshallow`;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}
