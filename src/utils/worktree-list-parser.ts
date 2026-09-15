export interface ParsedWorktree {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  prunable: boolean;
  locked: boolean;
  /**
   * Reason recorded by `git worktree lock --reason`, exactly as git prints it;
   * null for a lock without a reason. Git runs the reason through
   * `quote_c_style`, so an ordinary reason appears verbatim while one holding a
   * newline, quote or backslash comes back double-quoted with C escapes — which
   * keeps this value single-line and safe to put in a log message.
   */
  lockReason: string | null;
}

export function parseWorktreeListPorcelain(output: string): ParsedWorktree[] {
  const worktrees: ParsedWorktree[] = [];
  let current: Partial<ParsedWorktree> = {};

  const flush = (): void => {
    if (!current.path) {
      current = {};
      return;
    }
    worktrees.push({
      path: current.path,
      branch: current.branch ?? null,
      head: current.head ?? null,
      detached: current.detached ?? false,
      prunable: current.prunable ?? false,
      locked: current.locked ?? false,
      lockReason: current.lockReason ?? null,
    });
    current = {};
  };

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current.path = line.substring("worktree ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.substring("branch ".length).replace("refs/heads/", "");
    } else if (line.startsWith("HEAD ")) {
      current.head = line.substring("HEAD ".length);
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
      const reason = line.substring("locked ".length).trim();
      current.lockReason = reason.length > 0 ? reason : null;
    } else if (line.trim() === "") {
      flush();
    }
  }
  flush();
  return worktrees;
}
