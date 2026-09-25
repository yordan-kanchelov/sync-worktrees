import { GitError as SimpleGitError } from "simple-git";

import { SyncWorktreesError } from "../errors";

/**
 * The text to print for a failure the person running the tool can act on — a
 * git command that failed (unreachable remote, bad credentials, missing
 * repository) or one of this tool's own typed errors — or `null` for anything
 * else, which is a bug and keeps its full inspected form and stack.
 *
 * simple-git's message is git's whole stderr ("Cloning into ...", progress,
 * two `fatal:` lines and a paragraph of advice), and `util.inspect` adds a
 * stack of simple-git internals and the `task.commands` array on top: ~30
 * lines for "the URL is wrong". The first `fatal:`/`error:` line is the one
 * that names the cause.
 */
export function summarizeExpectedError(error: unknown): string | null {
  if (error instanceof SyncWorktreesError) {
    // "Cannot fast-forward branch 'x'" says what failed, not why; git's reason
    // is on the cause, so it rides along as one line — unless the message
    // already quotes it.
    const reason = error.cause ? reasonLine(summarizeExpectedError(error.cause) ?? error.cause.message) : "";
    return reason && !error.message.includes(reason) ? `${error.message}: ${reason}` : error.message;
  }
  if (!(error instanceof SimpleGitError)) return null;
  return reasonLine(error.message) || error.message;
}

/** The first `fatal:`/`error:` line of `text`, else its first non-blank line. */
function reasonLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => /^(fatal|error):/i.test(line)) ?? lines[0] ?? "";
}
