import simpleGit from "simple-git";

import { GIT_UNSAFE_ALLOWANCES, sanitizeGitEnv } from "./git-env";

import type { SimpleGit, SimpleGitOptions } from "simple-git";

export const SIMPLE_GIT_CLIENT_CONCURRENCY = 5;

export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const MIN_GIT_TIMEOUT_MS = 1_000;

export const GIT_LOCALE_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({ LC_ALL: "C", LANG: "C" });

export function buildGitClientOptions(options: Partial<SimpleGitOptions> = {}): Partial<SimpleGitOptions> {
  const clientOptions: Partial<SimpleGitOptions> = {
    ...options,
    unsafe: { ...GIT_UNSAFE_ALLOWANCES, ...options.unsafe },
  };
  const block = options.timeout?.block;
  if (block !== undefined && block > MAX_TIMER_DELAY_MS) {
    clientOptions.timeout = { ...options.timeout, block: MAX_TIMER_DELAY_MS };
  }
  return clientOptions;
}

export function createGitClient(
  baseDir?: string,
  extraEnv: NodeJS.ProcessEnv = {},
  options?: Partial<SimpleGitOptions>,
): SimpleGit {
  const clientOptions = buildGitClientOptions(options);
  const client = baseDir === undefined ? simpleGit(clientOptions) : simpleGit(baseDir, clientOptions);
  return client.env({ ...sanitizeGitEnv(process.env), ...GIT_LOCALE_ENV, ...extraEnv });
}
