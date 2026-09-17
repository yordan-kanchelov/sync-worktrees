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

// Run every git in the suite against an empty global config and no system
// config. Without this the tests inherit whatever git configuration the host
// has, and one inherited key silently inverts results: `git lfs install`
// defines `filter.lfs.process`, and git prefers a long-running process filter
// over `smudge`/`clean` and never falls back to them. The LFS suites install a
// deliberately failing `filter.lfs.smudge` to stand in for a broken LFS setup,
// so on a machine with git-lfs (every GitHub Actions runner) that smudge never
// ran, the checkout succeeded, and the assertions that expect a failure all
// inverted — green here, red in CI. A test that reads the developer's own git
// config is not reproducible anyway; a suite that spawns real git has to pin
// it. Set unconditionally: honouring an exported GIT_CONFIG_GLOBAL would let
// the developer's own shell put the suite back where it started. Suites that
// need a global config of their own set it for the child they spawn, which
// still wins, because that child's env overrides this one.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

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
