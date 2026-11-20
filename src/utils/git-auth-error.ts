import { getErrorMessage } from "./errors";

const GIT_AUTH_ERROR_PATTERNS = Object.freeze([
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
  "add the host to ~/.ssh/known_hosts first. Compare the key against the fingerprint your git host publishes " +
  "before trusting it: `ssh-keyscan <host> | ssh-keygen -lf -` to read the fingerprint, then append that same " +
  "`ssh-keyscan <host>` output to ~/.ssh/known_hosts once it matches.";

const HINT_PREFIX = "Hint: ";

export function isGitAuthError(errorMessage: string): boolean {
  return GIT_AUTH_ERROR_PATTERNS.some((pattern) => errorMessage.includes(pattern));
}

export function isGitAuthErrorFromError(error: unknown): boolean {
  return isGitAuthError(getErrorMessage(error));
}

export function getGitAuthHint(errorMessage: string): string | undefined {
  if (!isGitAuthError(errorMessage)) return undefined;
  if (errorMessage.includes("Host key verification failed")) return SSH_HOST_KEY_HINT;
  if (errorMessage.includes("Permission denied (")) return SSH_KEY_HINT;
  return HTTPS_CREDENTIAL_HINT;
}

export function appendGitAuthHint(errorMessage: string): string {
  const hint = getGitAuthHint(errorMessage);
  if (hint === undefined || errorMessage.includes(HINT_PREFIX)) return errorMessage;
  return `${errorMessage.trimEnd()}\n${HINT_PREFIX}${hint}`;
}

export function withGitAuthHint(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const hinted = appendGitAuthHint(error.message);
  if (hinted === error.message) return error;
  return new Error(hinted, { cause: error });
}
