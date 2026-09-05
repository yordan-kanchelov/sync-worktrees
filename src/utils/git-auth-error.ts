import { getErrorMessage } from "./lfs-error";

/**
 * git / ssh stderr fragments that mean the remote refused us or needed input
 * we can never supply (every git subprocess runs non-interactively: see
 * sanitizeGitEnv). Matched as substrings of the error message.
 */
export const GIT_AUTH_ERROR_PATTERNS = Object.freeze([
  "terminal prompts disabled",
  "could not read Username",
  "could not read Password",
  "Authentication failed",
  "Permission denied (publickey",
  "Permission denied (password",
  "Host key verification failed",
] as const);

const HTTPS_CREDENTIAL_HINT =
  "sync-worktrees runs git non-interactively (GIT_TERMINAL_PROMPT=0) and cannot answer a credential prompt: " +
  "configure a git credential helper that can supply credentials for this remote " +
  "(e.g. `git config --global credential.helper <helper>`), or switch repoUrl to an SSH URL with a key in ssh-agent.";

const SSH_KEY_HINT =
  "sync-worktrees runs git non-interactively and cannot answer an ssh prompt: " +
  "load a key the remote accepts into ssh-agent (or use an unencrypted key) for the user running sync-worktrees.";

const SSH_HOST_KEY_HINT =
  "sync-worktrees runs git non-interactively and cannot confirm a host key: " +
  "add the host to ~/.ssh/known_hosts first (e.g. `ssh-keyscan <host> >> ~/.ssh/known_hosts`, or run `ssh <host>` once).";

const HINT_PREFIX = "Hint: ";

/**
 * Checks if an error message indicates a git authentication / prompt failure
 * that retrying cannot fix.
 */
export function isGitAuthError(errorMessage: string): boolean {
  return GIT_AUTH_ERROR_PATTERNS.some((pattern) => errorMessage.includes(pattern));
}

/**
 * Checks if an error object indicates a git authentication / prompt failure.
 */
export function isGitAuthErrorFromError(error: unknown): boolean {
  return isGitAuthError(getErrorMessage(error));
}

/**
 * One-line remedy for a git authentication / prompt failure, or undefined when
 * the message is not one.
 */
export function getGitAuthHint(errorMessage: string): string | undefined {
  if (!isGitAuthError(errorMessage)) return undefined;
  if (errorMessage.includes("Host key verification failed")) return SSH_HOST_KEY_HINT;
  if (errorMessage.includes("Permission denied (")) return SSH_KEY_HINT;
  return HTTPS_CREDENTIAL_HINT;
}

/**
 * Appends the remedy hint to a git authentication / prompt failure message.
 * Any other message — and a message that already carries the hint — is
 * returned unchanged.
 */
export function appendGitAuthHint(errorMessage: string): string {
  const hint = getGitAuthHint(errorMessage);
  if (hint === undefined || errorMessage.includes(HINT_PREFIX)) return errorMessage;
  return `${errorMessage.trimEnd()}\n${HINT_PREFIX}${hint}`;
}

/**
 * Returns an Error whose message carries the remedy hint when `error` is a git
 * authentication / prompt failure; the original error is kept as `cause` so
 * logs that inspect the error still show git's stderr and the failed command.
 * Any other value is returned as is.
 */
export function withGitAuthHint(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const hinted = appendGitAuthHint(error.message);
  if (hinted === error.message) return error;
  return new Error(hinted, { cause: error });
}
