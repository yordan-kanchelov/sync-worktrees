// Vitest setup file for global test configuration
import { afterEach, vi } from "vitest";

import { ENV_CONSTANTS } from "../constants";

// NODE_ENV=test is kept for the libraries that key off it (React/Ink pick their
// development builds from it); no sync-worktrees code path branches on it.
process.env.NODE_ENV = "test";

// Opt this vitest worker into the in-process unit-test shortcuts (no
// cross-process repo lock, no git inactivity timeouts, no trash reaping or
// periodic gc — see src/utils/unit-test-shortcut.ts). The value is the worker's
// own pid: child processes spawned by the e2e suites inherit the variable but
// never match it, so the built CLI always runs the real code paths.
process.env[ENV_CONSTANTS.UNIT_TEST_SHORTCUT] = String(process.pid);

// Ink v7 measures terminal dimensions via the `terminal-size` package. When
// stdout/stderr aren't real TTYs (vitest workers) and /dev/tty is unavailable,
// it shells out to `tput` (execFileSync) — and Ink's getWindowSize() calls it
// several times per render, adding ~0.8s to every component test. terminal-size
// checks COLUMNS/LINES before spawning, so providing them keeps it spawn-free.
process.env.COLUMNS = process.env.COLUMNS || "80";
process.env.LINES = process.env.LINES || "24";

// Mock console methods to reduce noise in test output
global.console = {
  ...console,
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};

// Reset mocks after each test
afterEach(() => {
  vi.clearAllMocks();
});
