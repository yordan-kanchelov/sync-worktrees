import type { RepoLockUnavailable } from "../types";

export function formatRepoLockUnavailable(detail: Pick<RepoLockUnavailable, "path" | "code" | "error">): string {
  return `repository lock unavailable at '${detail.path}' (${detail.code ?? "unknown"}: ${detail.error})`;
}
