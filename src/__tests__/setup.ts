// Vitest setup file for global test configuration
import { afterEach, vi } from "vitest";

// Ensure NODE_ENV is set to test
process.env.NODE_ENV = "test";

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
