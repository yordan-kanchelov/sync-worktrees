import { ENV_CONSTANTS } from "../constants";

let probe: Promise<boolean> | null = null;
let warned = false;

export const GIT_LFS_MISSING_WARNING =
  "  - ⚠️ git-lfs is not installed, so LFS files cannot be verified. " +
  "Install git-lfs, or set 'skipLfs: true' for this repository to check out LFS pointers instead.";

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

export function warnGitLfsMissingOnce(warn: (message: string) => void): void {
  if (warned) return;
  warned = true;
  warn(GIT_LFS_MISSING_WARNING);
}

export function resetGitLfsProbeForTests(): void {
  probe = null;
  warned = false;
}

export function isLfsSmudgeSkippedByEnv(): boolean {
  const value = process.env[ENV_CONSTANTS.GIT_LFS_SKIP_SMUDGE]?.toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes" || value === "t";
}
