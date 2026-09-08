import simpleGit from "simple-git";

import { GIT_UNSAFE_ALLOWANCES, sanitizeGitEnv } from "./git-env";

import type { SimpleGit, SimpleGitOptions } from "simple-git";

/**
 * Concurrent git processes one simple-git client will run. Its scheduler is
 * per-client and no client here overrides `maxConcurrentProcesses`, so this is
 * simple-git's default. It bounds nothing across clients — each worktree gets
 * its own — but every call that shares a single cached client (branch fetches
 * through the anchor worktree, `worktree add`/`remove` through the bare repo)
 * is capped here no matter what concurrency the caller asks for.
 */
export const SIMPLE_GIT_CLIENT_CONCURRENCY = 5;

/**
 * Options every simple-git client is constructed with: the caller's options
 * (progress handler, block timeout, ...) plus the centralized unsafe-env
 * allowances. Callers must never construct a client without them — every
 * client passes an explicit env (see createGitClient), and simple-git rejects
 * an explicit env that carries an unallowed variable before spawning git.
 */
export function buildGitClientOptions(options: Partial<SimpleGitOptions> = {}): Partial<SimpleGitOptions> {
  return { ...options, unsafe: { ...GIT_UNSAFE_ALLOWANCES, ...options.unsafe } };
}

/**
 * The single way to build a simple-git client. The client runs git with the
 * sanitized parent environment (non-interactive: GIT_TERMINAL_PROMPT=0, no
 * editor) plus the caller's per-client additions such as GIT_LFS_SKIP_SMUDGE
 * or GIT_ATTR_SOURCE. `baseDir` undefined builds a client without a working
 * directory (clone, ls-remote against a URL).
 */
export function createGitClient(
  baseDir?: string,
  extraEnv: NodeJS.ProcessEnv = {},
  options?: Partial<SimpleGitOptions>,
): SimpleGit {
  const clientOptions = buildGitClientOptions(options);
  const client = baseDir === undefined ? simpleGit(clientOptions) : simpleGit(baseDir, clientOptions);
  return client.env({ ...sanitizeGitEnv(process.env), ...extraEnv });
}
