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
 * The longest delay a Node timer holds. A larger one does not fit the 32-bit
 * field, so Node warns and substitutes 1 ms: an inactivity timeout of a year
 * would kill every git command it guards a millisecond after it started.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * The shortest non-zero `fetchTimeoutMs` / `cloneTimeoutMs` the config loader
 * accepts. A smaller window is almost always a value given in seconds, and it
 * would kill nearly every git command it guards.
 */
export const MIN_GIT_TIMEOUT_MS = 1_000;

/**
 * The environment every client forces so git's messages are deterministic
 * English. Callers match git's stderr/stdout text ("no upstream configured",
 * "unknown revision or path", "stale info", LFS and missing-ref errors), and
 * under a non-English LANG/LC_ALL those matches silently stop working.
 * LANGUAGE needs no override: gettext ignores it when the locale is "C".
 */
export const GIT_LOCALE_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({ LC_ALL: "C", LANG: "C" });

/**
 * Options every simple-git client is constructed with: the caller's options
 * (progress handler, block timeout, ...) plus the centralized unsafe-env
 * allowances. Callers must never construct a client without them — every
 * client passes an explicit env (see createGitClient), and simple-git rejects
 * an explicit env that carries an unallowed variable before spawning git.
 */
export function buildGitClientOptions(options: Partial<SimpleGitOptions> = {}): Partial<SimpleGitOptions> {
  const clientOptions: Partial<SimpleGitOptions> = {
    ...options,
    unsafe: { ...GIT_UNSAFE_ALLOWANCES, ...options.unsafe },
  };
  // The config loader rejects an out-of-range timeout; this covers a Config
  // built in code, so an oversized block timeout cannot wrap to an instant kill.
  const block = options.timeout?.block;
  if (block !== undefined && block > MAX_TIMER_DELAY_MS) {
    clientOptions.timeout = { ...options.timeout, block: MAX_TIMER_DELAY_MS };
  }
  return clientOptions;
}

/**
 * The single way to build a simple-git client. The client runs git with the
 * sanitized parent environment (non-interactive: GIT_TERMINAL_PROMPT=0, no
 * editor, no inherited repository-selection variable that would outrank
 * `baseDir` — see sanitizeGitEnv), the C locale (GIT_LOCALE_ENV) and the
 * caller's per-client additions such as GIT_LFS_SKIP_SMUDGE or GIT_ATTR_SOURCE.
 * Those additions are merged last, so a variable this tool passes on purpose
 * still reaches git. `baseDir` undefined builds a client without a working
 * directory (clone, ls-remote against a URL).
 */
export function createGitClient(
  baseDir?: string,
  extraEnv: NodeJS.ProcessEnv = {},
  options?: Partial<SimpleGitOptions>,
): SimpleGit {
  const clientOptions = buildGitClientOptions(options);
  const client = baseDir === undefined ? simpleGit(clientOptions) : simpleGit(baseDir, clientOptions);
  return client.env({ ...sanitizeGitEnv(process.env), ...GIT_LOCALE_ENV, ...extraEnv });
}
