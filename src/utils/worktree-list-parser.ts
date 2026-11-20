import type { SimpleGit } from "simple-git";

export interface ParsedWorktree {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  prunable: boolean;
  locked: boolean;
  lockReason: string | null;
}

const WORKTREE_LIST_ARGS = ["worktree", "list", "--porcelain"];

let nulListingUnsupported = false;

export async function readWorktreeListPorcelain(git: Pick<SimpleGit, "raw">): Promise<string> {
  if (!nulListingUnsupported) {
    try {
      return await git.raw([...WORKTREE_LIST_ARGS, "-z"]);
    } catch (err) {
      if (!/unknown switch/i.test(err instanceof Error ? err.message : String(err))) throw err;
      nulListingUnsupported = true;
    }
  }
  return git.raw(WORKTREE_LIST_ARGS);
}

export function resetWorktreeListCapabilityForTests(): void {
  nulListingUnsupported = false;
}

// eslint-disable-next-line no-control-regex
const NEEDS_QUOTING = /["\\\x00-\x1f\x7f]/g;
const C_ESCAPES: Record<string, string> = { "\n": "\\n", "\t": "\\t", "\r": "\\r", '"': '\\"', "\\": "\\\\" };

function quoteCStyle(value: string): string {
  const body = value.replace(
    NEEDS_QUOTING,
    (ch) => C_ESCAPES[ch] ?? `\\${ch.charCodeAt(0).toString(8).padStart(3, "0")}`,
  );
  return body === value ? value : `"${body}"`;
}

export function parseWorktreeListPorcelain(output: string): ParsedWorktree[] {
  const nulTerminated = output.includes("\0");
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

  for (const line of output.split(nulTerminated ? "\0" : "\n")) {
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
      const raw = line.substring("locked ".length);
      const reason = nulTerminated ? quoteCStyle(raw.trim()) : raw.trim();
      current.lockReason = reason.length > 0 ? reason : null;
    } else if (line.trim() === "") {
      flush();
    }
  }
  flush();
  return worktrees;
}
