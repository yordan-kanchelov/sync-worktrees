import type { SimpleGit } from "simple-git";

export interface ParsedWorktree {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  prunable: boolean;
  locked: boolean;
  /**
   * Reason recorded by `git worktree lock --reason`; null for a lock without
   * a reason. An ordinary reason appears verbatim while one holding a newline,
   * quote, backslash or other control character comes back double-quoted with
   * C escapes — which keeps this value single-line and safe to put in a log
   * message. Newline-terminated output arrives quoted that way by git itself
   * (`quote_c_style`); NUL-terminated output (`-z`) carries the raw reason, so
   * the parser applies the same quoting.
   */
  lockReason: string | null;
}

const WORKTREE_LIST_ARGS = ["worktree", "list", "--porcelain"];

// Set once a git without `worktree list -z` (added in git 2.36) has refused it,
// so every later listing in the process goes straight to the newline form.
let nulListingUnsupported = false;

/**
 * `git worktree list --porcelain` output for parseWorktreeListPorcelain,
 * NUL-terminated when git supports it. The newline form cannot represent a
 * worktree path containing a newline — git prints it raw, splitting one record
 * across two lines — so it is only the fallback for a git older than 2.36,
 * which rejects `-z` with "unknown switch".
 */
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

/** Test hook: forget a recorded `-z` refusal. */
export function resetWorktreeListCapabilityForTests(): void {
  nulListingUnsupported = false;
}

// eslint-disable-next-line no-control-regex
const NEEDS_QUOTING = /["\\\x00-\x1f\x7f]/g;
const C_ESCAPES: Record<string, string> = { "\n": "\\n", "\t": "\\t", "\r": "\\r", '"': '\\"', "\\": "\\\\" };

// git's quote_c_style for a value that must stay on one line: verbatim unless
// it holds a double quote, a backslash or a control character.
function quoteCStyle(value: string): string {
  const body = value.replace(
    NEEDS_QUOTING,
    (ch) => C_ESCAPES[ch] ?? `\\${ch.charCodeAt(0).toString(8).padStart(3, "0")}`,
  );
  return body === value ? value : `"${body}"`;
}

/**
 * Parses `git worktree list --porcelain` output in either form: NUL-terminated
 * (`-z`, recognised by the presence of a NUL) or newline-terminated.
 */
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
