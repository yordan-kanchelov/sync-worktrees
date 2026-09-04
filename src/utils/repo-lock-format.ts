import type { RepoLockUnavailable } from "../types";

// One rendering for every surface (CLI, TUI, MCP) so the path and errno that
// explain an unavailable lock are never dropped on the way to the user.
export function formatRepoLockUnavailable(detail: Pick<RepoLockUnavailable, "path" | "code" | "error">): string {
  return `repository lock unavailable at '${detail.path}' (${detail.code ?? "unknown"}: ${detail.error})`;
}
