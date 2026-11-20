import { GitError as SimpleGitError } from "simple-git";

import { SyncWorktreesError } from "../errors";

export function summarizeExpectedError(error: unknown): string | null {
  if (error instanceof SyncWorktreesError) {
    const reason = error.cause ? reasonLine(summarizeExpectedError(error.cause) ?? error.cause.message) : "";
    return reason && !error.message.includes(reason) ? `${error.message}: ${reason}` : error.message;
  }
  if (!(error instanceof SimpleGitError)) return null;
  return reasonLine(error.message) || error.message;
}

function reasonLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => /^(fatal|error):/i.test(line)) ?? lines[0] ?? "";
}
