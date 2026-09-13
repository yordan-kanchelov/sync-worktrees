/**
 * What this process knows about its git-lfs setup: whether the binary is
 * installed, the one warning that says it is not, and whether the environment
 * already disables the smudge filter.
 *
 * Whether git-lfs is installed is a machine-wide fact that cannot change while
 * the process runs, and LFS verification would ask once per created worktree —
 * a first sync of a hundred branches would spawn a hundred probes and print a
 * hundred identical warnings. So the probe runs, and the warning is emitted, at
 * most once per process.
 */

import { ENV_CONSTANTS } from "../constants";

let probe: Promise<boolean> | null = null;
let warned = false;

/** Warning text for a machine without git-lfs; emitted at most once (see below). */
export const GIT_LFS_MISSING_WARNING =
  "  - ⚠️ git-lfs is not installed, so LFS files cannot be verified. " +
  "Install git-lfs, or set 'skipLfs: true' for this repository to check out LFS pointers instead.";

/**
 * Runs `runProbe` (a `git lfs version` on any client) the first time it is
 * asked and reuses that answer for the rest of the process; a rejection means
 * git-lfs is not installed. Later callers' `runProbe` is never invoked, which
 * is the point: the answer does not depend on which repository asked.
 */
export function isGitLfsInstalled(runProbe: () => Promise<unknown>): Promise<boolean> {
  probe ??= (async () => {
    try {
      await runProbe();
      return true;
    } catch {
      return false;
    }
  })();
  return probe;
}

/** Emits GIT_LFS_MISSING_WARNING through `warn` on the first call only. */
export function warnGitLfsMissingOnce(warn: (message: string) => void): void {
  if (warned) return;
  warned = true;
  warn(GIT_LFS_MISSING_WARNING);
}

/** Test hook: forget the probe result and the warning latch. */
export function resetGitLfsProbeForTests(): void {
  probe = null;
  warned = false;
}

/**
 * Whether this process's environment already disables the LFS smudge filter.
 * git-lfs reads GIT_LFS_SKIP_SMUDGE as a git-style boolean, so "1", "true",
 * "on" and "yes" all leave pointer files in the working copy — the expected
 * outcome then, not a checkout that went wrong. A shell or CI job exporting it
 * without `skipLfs: true` in the config is the common way to get there.
 *
 * Matched the way git-lfs matches it: lower-cased but never trimmed, so a
 * padded value (" 1 "), which git-lfs does not recognise and therefore still
 * smudges for, keeps its verification.
 */
export function isLfsSmudgeSkippedByEnv(): boolean {
  const value = process.env[ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE]?.toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes" || value === "t";
}
