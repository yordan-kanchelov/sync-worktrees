import { ENV_CONSTANTS } from "../constants";

export function isUnitTestShortcutEnabled(): boolean {
  return process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT] === String(process.pid);
}

export function warnIfUnitTestShortcutEnabled(write: (message: string) => void): void {
  if (!isUnitTestShortcutEnabled()) return;
  write(
    `⚠️  ${ENV_CONSTANTS.UNIT_TEST_SHORTCUT} is active for this process (pid ${process.pid}): ` +
      "cross-process repository locking, git inactivity timeouts, trash reaping and periodic git gc are DISABLED. " +
      "This variable exists only for the unit test suite; unset it before running sync-worktrees for real.",
  );
}
