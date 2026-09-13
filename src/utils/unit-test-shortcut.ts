import { ENV_CONSTANTS } from "../constants";

// The unit suite constructs the services in-process against mocked git/fs, so
// the cross-process repo lock, the git inactivity timeouts, trash reaping and
// periodic gc are short-circuited for it. The opt-in is deliberately scoped to
// one process: src/__tests__/setup.ts stores the vitest worker's own pid in
// SYNC_WORKTREES_UNIT_TEST, and only a process whose pid matches honours it.
// Child processes inherit process.env wholesale — the e2e suites spawn the
// built CLI with the worker's environment, hooks spawn user commands — but
// their pid never matches, so they always run the real code paths. Nothing
// here may depend on NODE_ENV: shells, CI jobs and .env files export it for
// their own reasons and must not silently switch off safety features.
export function isUnitTestShortcutEnabled(): boolean {
  return process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT] === String(process.pid);
}

// Process entry points call this once at startup so a stray copy of the
// variable can never disable locking, timeouts, trash reaping or gc unnoticed.
export function warnIfUnitTestShortcutEnabled(write: (message: string) => void): void {
  if (!isUnitTestShortcutEnabled()) return;
  write(
    `⚠️  ${ENV_CONSTANTS.UNIT_TEST_SHORTCUT} is active for this process (pid ${process.pid}): ` +
      "cross-process repository locking, git inactivity timeouts, trash reaping and periodic git gc are DISABLED. " +
      "This variable exists only for the unit test suite; unset it before running sync-worktrees for real.",
  );
}
